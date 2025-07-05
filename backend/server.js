// server.js (UPDATED: Corrected 'app' identifier conflict)

const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const fs = require('fs').promises; // Use .promises for async fs functions
const crypto = require('crypto'); // Import crypto for MD5 hash

// IMPORTANT: Require 'electron' to get the app object, needed for app.isPackaged
// Renamed to 'electronApp' to avoid conflict with the 'express' app instance
const { app: electronApp } = require('electron');
const isPackaged = electronApp.isPackaged; // Use the renamed variable here

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// This is your Express application instance
const app = express();
// The port is now dynamically assigned by Electron's main process.
// const port = 4000; // This line is not actively used when imported by main.js

app.use(cors());
app.use(express.json());

// __dirname is globally available in CommonJS modules (which Electron's main process is by default)

// Define the base path for data files based on whether the app is packaged
const dataBasePath = isPackaged
  ? path.join(process.resourcesPath, 'data') // In packaged app, 'data' is copied directly into Resources
  : path.join(__dirname, '..', 'data'); // In development, 'data' is relative to backend/server.js

console.log('Server Init: isPackaged =', isPackaged);
console.log('Server Init: dataBasePath =', dataBasePath);


// OpenAI API client initialization
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- RAG Implementation ---

// Cache to store loaded and embedded case data
// Structure: { 'caseId': { patientDocs: [], physicianDocs: [], physicianKeyHistoryPoints: [] } }
const caseDataCache = {};
// Cache to store loaded and embedded patient transcript data per caseId per session
// Now stores { data: [], hash: '...' } to detect transcript changes
const patientTranscriptEmbeddingsCache = {};

// Helper function for cosine similarity, used to compare embeddings
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magnitudeA += vecA[i] * vecA[i];
    magnitudeB += vecB[i] * vecB[i];
  }
  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return dotProduct / (magnitudeA * magnitudeB);
}

// Helper to extract simple keywords from text for hybrid search
function extractKeywords(text) {
    // Basic tokenization and filtering for common words/short strings
    return text.toLowerCase().split(/\W+/)
        .filter(word => word.length > 2 && !['the', 'and', 'for', 'with', 'what', 'how', 'when', 'what', 'you', 'can', 'will', 'are', 'not'].includes(word));
}

// Function to load and process a single JSON file (patient OR physician) for RAG
async function processCaseJson(caseId, type) {
    try {
        // Correct path to data/cases relative to server.js
        const jsonPath = path.join(dataBasePath, 'cases', `${caseId}_${type}.json`); // UPDATED PATH
        console.log(`Attempting to read ${caseId}_${type}.json from:`, jsonPath); // Add this
        const data = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));

        const documents = []; // Stores the final documents with text, embedding, and metadata
        let keyHistoryPoints = []; // Only populated for physician type, stores embedded key points

        // Function to recursively process data and create chunks with hierarchy and keywords
        function createChunks(obj, currentPath = [], level = 0) {
            if (typeof obj !== 'object' || obj === null) {
                // Base case: if it's a primitive value, create a chunk
                const text = `${currentPath.join(' ')}: ${obj}`;
                documents.push({
                    text: text,
                    metadata: {
                        source: `${type} ${currentPath[0]}`,
                        path: currentPath.join('.'),
                        level: level,
                        keywords: extractKeywords(text)
                    }
                });
                return;
            }

            // If it's an object or array, recurse
            for (const key in obj) {
                const newPath = [...currentPath, key];
                const content = obj[key];

                if (Array.isArray(content)) {
                    const arraySummary = `${key}: ${content.join('; ')}`;
                    documents.push({
                        text: arraySummary,
                        metadata: {
                            source: `${type} ${newPath[0]}`,
                            path: newPath.join('.'),
                            level: level + 1,
                            keywords: extractKeywords(arraySummary)
                        }
                    });
                    content.forEach((item, index) => createChunks(item, [...newPath, String(index)], level + 2));
                } else if (typeof content === 'object' && content !== null) {
                    const objectSummary = `${key}: ${JSON.stringify(content)}`;
                     documents.push({
                        text: objectSummary,
                        metadata: {
                            source: `${type} ${newPath[0]}`,
                            path: newPath.join('.'),
                            level: level + 1,
                            keywords: extractKeywords(objectSummary)
                        }
                    });
                    createChunks(content, newPath, level + 1);
                } else {
                    const text = `${key}: ${content}`;
                    documents.push({
                        text: text,
                        metadata: {
                            source: `${type} ${newPath[0]}`,
                            path: newPath.join('.'),
                            level: level + 1,
                            keywords: extractKeywords(text)
                        }
                    });
                }
            }
        }

        if (type === 'patient') {
            if (data.summary) createChunks(data.summary, ['summary'], 0);
            if (data.meta) createChunks(data.meta, ['meta'], 0);
            if (data.system_prompt) createChunks(data.system_prompt, ['system_prompt'], 0);
            if (data.patient_profile) createChunks(data.patient_profile, ['patient_profile'], 0);
            if (data.symptoms) createChunks(data.symptoms, ['symptoms'], 0);
            if (data.patient_responses) createChunks(data.patient_responses, ['patient_responses'], 0);
        } else if (type === 'physician') {
            if (data.summary) createChunks(data.summary, ['summary'], 0);
            if (data.system_prompt) createChunks(data.system_prompt, ['system_prompt'], 0);

            if (data.keyHistoryPoints) {
                const keyPointEmbeddingPromises = data.keyHistoryPoints.map(async (pointObj) => {
                    const embeddingResponse = await openai.embeddings.create({
                        model: "text-embedding-3-small",
                        input: pointObj.point,
                    });
                    return { ...pointObj, embedding: embeddingResponse.data[0].embedding };
                });
                keyHistoryPoints = await Promise.all(keyPointEmbeddingPromises);
                createChunks(data.keyHistoryPoints, ['keyHistoryPoints'], 0);
            }

            if (data.teachingFlow) createChunks(data.teachingFlow, ['teachingFlow'], 0);
            if (data.relevantInvestigations) createChunks(data.relevantInvestigations, ['relevantInvestigations'], 0);
            if (data.differentialDiagnosis) createChunks(data.differentialDiagnosis, ['differentialDiagnosis'], 0);
            if (data.commonMedications) createChunks(data.commonMedications, ['commonMedications'], 0);
        }

        const embeddingPromises = documents.map(async (doc) => {
            const embeddingResponse = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: doc.text,
            });
            doc.embedding = embeddingResponse.data[0].embedding;
            return doc;
        });

        const indexedDocuments = await Promise.all(embeddingPromises);

        console.log(`Successfully indexed ${indexedDocuments.length} chunks for ${type} data for case ${caseId}.`);
        return { documents: indexedDocuments, keyHistoryPoints: keyHistoryPoints };

    } catch (error) {
        console.error(`Error loading or processing ${type} data for case ${caseId}:`, error);
        return { documents: [], keyHistoryPoints: [] };
    }
}

// Function to process a raw transcript string into RAG-ready chunks with overlap
async function processTranscriptForRAG(transcriptContent) {
    if (!transcriptContent) {
        return [];
    }

    const lines = transcriptContent.split('\n').filter(line => line.trim().length > 20);
    const chunks = [];
    const overlap_size = 2; // Number of previous lines to include in the current chunk for overlap.

    for (let i = 0; i < lines.length; i++) {
        let currentChunkText = lines[i];
        for (let j = 1; j <= overlap_size; j++) {
            if (i - j >= 0) {
                currentChunkText = lines[i - j] + '\n' + currentChunkText;
            } else {
                break;
            }
        }

        const trimmedChunk = currentChunkText.trim();
        if (trimmedChunk) {
            chunks.push({
                text: trimmedChunk,
                source: 'patient_transcript_dynamic',
                turn_number: i,
                keywords: extractKeywords(trimmedChunk)
            });
        }
    }

    if (chunks.length === 0) {
        console.warn("No meaningful chunks found in patient transcript for embedding after overlap processing.");
        return [];
    }

    const embeddingPromises = chunks.map(async (chunk) => {
        const response = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: chunk.text,
        });
        return {
            text: chunk.text,
            embedding: response.data[0].embedding,
            metadata: { source: chunk.source, turn_number: chunk.turn_number, keywords: chunk.keywords }
        };
    });

    const indexedDocuments = await Promise.all(embeddingPromises);
    console.log(`Successfully indexed ${indexedDocuments.length} chunks from patient transcript with overlap.`);
    return indexedDocuments;
}

// Function to analyze patient transcript for covered/missed points using embeddings
async function analyzePatientTranscript(patientTranscript, keyPointsWithEmbeddings) {
    const coveredPoints = new Set();
    const missedPoints = new Set(keyPointsWithEmbeddings.map(p => p.point));
    const similarityThreshold = 0.7;

    const studentMessages = patientTranscript.split('\n').filter(line => line.startsWith('Student: '));
    const studentQuestions = studentMessages.map(line => line.substring('Student: '.length).trim());

    if (studentQuestions.length === 0) {
        return {
            summary: "The student did not ask any discernible questions during the patient interaction.",
            covered: [],
            missed: Array.from(missedPoints)
        };
    }

    const studentQuestionEmbeddingsPromises = studentQuestions.map(q =>
        openai.embeddings.create({
            model: "text-embedding-3-small",
            input: q,
        }).then(response => response.data[0].embedding)
    );
    const studentQuestionEmbeddings = await Promise.all(studentQuestionEmbeddingsPromises);

    for (const keyPoint of keyPointsWithEmbeddings) {
        for (const studentQEmbedding of studentQuestionEmbeddings) {
            const similarity = cosineSimilarity(keyPoint.embedding, studentQEmbedding);
            if (similarity >= similarityThreshold) {
                coveredPoints.add(keyPoint.point);
                if (missedPoints.has(keyPoint.point)) {
                    missedPoints.delete(keyPoint.point);
                }
                break;
            }
        }
    }

    let summaryText = "Student's History Taking Performance:\n\n";
    const coveredArray = Array.from(coveredPoints);
    const missedArray = Array.from(missedPoints);

    if (coveredArray.length > 0) {
        summaryText += "Information Successfully Elicited:\n- " + coveredArray.join('\n- ') + '\n';
    } else {
        summaryText += "No specific key information points were identified as successfully elicited.\n";
    }

    if (missedArray.length > 0) {
        summaryText += "\nInformation Potentially Missed (Areas for Further Inquiry):\n- " + missedArray.join('\n- ') + '\n';
    } else if (coveredArray.length > 0) {
        summaryText += "\nAll identified key information points were successfully elicited.\n";
    }

    return {
        summary: summaryText,
        covered: coveredArray,
        missed: missedArray
    };
}


// This app.listen is now essentially dormant when integrated into Electron's main process,
// as the port is dynamically assigned by main.js. It's fine to leave it for standalone testing.
// app.listen(port, () => {
//   console.log(`Backend server running at http://localhost:${port}`);
// });


// --- NEW ENDPOINT: Get All Patient Cases for Index Page ---
app.get('/api/patient-cases', async (req, res) => {
    try {
        const patientCasesPath = path.join(dataBasePath, 'patient_cases.json'); // UPDATED PATH
        console.log('Attempting to read patient_cases.json from:', patientCasesPath); // Add this
        const data = await fs.readFile(patientCasesPath, 'utf-8');
        const cases = JSON.parse(data);
        res.status(200).json({ cases: cases }); // Wrap in an object for consistency
    } catch (error) {
        console.error('Error reading patient_cases.json:', error);
        res.status(500).json({ error: 'Failed to load patient cases data', details: error.message });
    }
});

// --- NEW ENDPOINT: Get a Specific Patient Case Entry from patient_cases.json ---
app.get('/api/case-details/:caseId', async (req, res) => {
    try {
        const { caseId } = req.params;
        const patientCasesPath = path.join(dataBasePath, 'patient_cases.json'); // UPDATED PATH
        const data = await fs.readFile(patientCasesPath, 'utf-8');
        const allCases = JSON.parse(data);
        const caseDetails = allCases.find(c => c.id === caseId);

        if (caseDetails) {
            res.status(200).json(caseDetails);
        } else {
            res.status(404).json({ error: `Case with ID ${caseId} not found.` });
        }
    } catch (error) {
        console.error('Error reading specific patient case details:', error);
        res.status(500).json({ error: 'Failed to load specific patient case data', details: error.message });
    }
});

// --- NEW ENDPOINT: Get content of specific case JSON file (e.g., peds001_patient.json) ---
app.get('/api/case-file/:caseId/:type', async (req, res) => {
    try {
        const { caseId, type } = req.params; // type will be 'patient' or 'physician'
        const filePath = path.join(dataBasePath, 'cases', `${caseId}_${type}.json`); // UPDATED PATH
        const data = await fs.readFile(filePath, 'utf-8');
        const fileContent = JSON.parse(data);
        res.status(200).json(fileContent);
    } catch (error) {
        console.error(`Error reading case file ${caseId}_${type}.json:`, error);
        res.status(500).json({ error: `Failed to load case file data for ${caseId}_${type}`, details: error.message });
    }
});


// --- ENDPOINT: Trigger Case Data Pre-loading ---
app.post('/api/preload-case-data', async (req, res) => {
    const { caseId } = req.body;

    if (!caseId) {
        return res.status(400).json({ error: 'caseId is required for preloading.' });
    }

    if (caseDataCache[caseId]) {
        console.log(`Case ${caseId} data already in cache. No preloading needed.`);
        return res.status(200).json({ message: `Case ${caseId} data already loaded.` });
    }

    try {
        console.log(`Preloading and processing data for case: ${caseId}`);
        const patientDataResult = await processCaseJson(caseId, 'patient');
        const physicianDataResult = await processCaseJson(caseId, 'physician');

        caseDataCache[caseId] = {
            patientDocs: patientDataResult.documents,
            physicianDocs: physicianDataResult.documents,
            physicianKeyHistoryPoints: physicianDataResult.keyHistoryPoints
        };
        console.log(`Case ${caseId} data preloaded and cached successfully.`);
        res.status(200).json({ message: `Case ${caseId} data preloaded and cached.` });

    } catch (error) {
        console.error(`Error preloading case ${caseId}:`, error);
        res.status(500).json({ error: `Failed to preload case data for ${caseId}`, details: error.message });
    }
});


// --- ENDPOINT: Chat route to OpenAI - handles all AI interactions (patient and physician)
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, chatType, caseId } = req.body;
    if (!messages || !caseId) {
      return res.status(400).json({ error: 'Messages and caseId are required' });
    }

    if (!caseDataCache[caseId]) {
        console.warn(`Case ${caseId} data not found in cache for chat request. Attempting to load on demand.`);
        const patientDataResult = await processCaseJson(caseId, 'patient');
        const physicianDataResult = await processCaseJson(caseId, 'physician');

        caseDataCache[caseId] = {
            patientDocs: patientDataResult.documents,
            physicianDocs: physicianDataResult.documents,
            physicianKeyHistoryPoints: physicianDataResult.keyHistoryPoints
        };
    }

    let currentDocumentsStore;
    let currentPhysicianKeyHistoryPoints;
    let currentPatientTranscriptDocuments = [];

    if (chatType === 'patient') {
        currentDocumentsStore = caseDataCache[caseId].patientDocs;
    } else if (chatType === 'physician') {
        currentDocumentsStore = caseDataCache[caseId].physicianDocs;
        currentPhysicianKeyHistoryPoints = caseDataCache[caseId].physicianKeyHistoryPoints;

        const patientTranscriptMessage = messages.find(msg =>
            msg && msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith('Here is the transcript of your interaction with the patient:')
        );

        const patientTranscriptContent = patientTranscriptMessage ? patientTranscriptMessage.content.substring('Here is the transcript of your interaction with the patient:\n\n'.length) : '';

        const currentTranscriptHash = patientTranscriptContent ? crypto.createHash('md5').update(patientTranscriptContent).digest('hex') : null;

        if (patientTranscriptContent && (!patientTranscriptEmbeddingsCache[caseId] || patientTranscriptEmbeddingsCache[caseId].hash !== currentTranscriptHash)) {
            console.log(`Processing patient transcript for RAG for case: ${caseId} (new or updated transcript).`);
            patientTranscriptEmbeddingsCache[caseId] = {
                data: await processTranscriptForRAG(patientTranscriptContent),
                hash: currentTranscriptHash
            };
        }
        if (patientTranscriptEmbeddingsCache[caseId] && patientTranscriptEmbeddingsCache[caseId].data) {
            currentPatientTranscriptDocuments = patientTranscriptEmbeddingsCache[caseId].data;
        }

    } else {
        console.warn(`Invalid chatType: ${chatType}. Proceeding without RAG context.`);
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: messages,
        });
        return res.json({ reply: completion.choices[0].message });
    }

    const systemPromptFromFrontend = messages[0]?.content;
    const rawPatientTranscriptForLLM = messages.find(msg =>
        msg && msg.role === 'system' && typeof msg.content === 'string' &&
        msg.content.startsWith('Here is the transcript of your interaction with the patient:')
    );
    const actualConversationHistory = messages.filter((msg, index) =>
        index !== 0 &&
        !(msg && msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith('Here is the transcript of your interaction with the patient:'))
    );


    const userMessage = actualConversationHistory[actualConversationHistory.length - 1]?.content;

    let retrievedContext = '';
    let performanceAnalysisResult = null;

    if (chatType === 'physician' && rawPatientTranscriptForLLM && currentPhysicianKeyHistoryPoints && currentPhysicianKeyHistoryPoints.length > 0) {
        performanceAnalysisResult = await analyzePatientTranscript(rawPatientTranscriptForLLM.content, currentPhysicianKeyHistoryPoints);
        console.log("Performance Analysis Summary:\n", performanceAnalysisResult.summary);
    }

    const retrievalQueries = [];
    if (userMessage) {
        retrievalQueries.push(userMessage);
    }
    if (chatType === 'physician' && performanceAnalysisResult && performanceAnalysisResult.missed.length > 0) {
        performanceAnalysisResult.missed.forEach(missedPoint => retrievalQueries.push(`Information missed by student: ${missedPoint}`));
    }

    if (retrievalQueries.length > 0) {
        const allDocumentsForRetrieval = (chatType === 'physician') ?
            [...currentDocumentsStore, ...currentPatientTranscriptDocuments] :
            currentDocumentsStore;

        if (allDocumentsForRetrieval.length > 0) {
            const uniqueRetrievedTexts = new Set();
            const k_initial = 15;
            const k_final = 5;

            let candidateDocuments = [];

            for (const query of retrievalQueries) {
                const queryEmbeddingResponse = await openai.embeddings.create({
                    model: "text-embedding-3-small",
                    input: query,
                });
                const queryEmbedding = queryEmbeddingResponse.data[0].embedding;
                const queryKeywords = extractKeywords(query);

                const scoredDocuments = allDocumentsForRetrieval.map(doc => {
                    const semanticSimilarity = cosineSimilarity(queryEmbedding, doc.embedding);
                    let keywordMatchScore = 0;
                    if (doc.metadata && doc.metadata.keywords) {
                        const matchingKeywords = doc.metadata.keywords.filter(kw => queryKeywords.includes(kw));
                        keywordMatchScore = matchingKeywords.length;
                    }

                    const combinedScore = semanticSimilarity + (keywordMatchScore * 0.1);

                    return { ...doc, semanticSimilarity, keywordMatchScore, combinedScore };
                });

                candidateDocuments.push(...scoredDocuments.sort((a, b) => b.combinedScore - a.combinedScore).slice(0, k_initial));
            }

            const uniqueCandidateDocsMap = new Map();
            candidateDocuments.forEach(doc => {
                if (!uniqueCandidateDocsMap.has(doc.text)) {
                    uniqueCandidateDocsMap.set(doc.text, doc);
                } else {
                    const existingDoc = uniqueCandidateDocsMap.get(doc.text);
                    if (doc.combinedScore > existingDoc.combinedScore) {
                        uniqueCandidateDocsMap.set(doc.text, doc);
                    }
                }
            });

            const finalRankedDocuments = Array.from(uniqueCandidateDocsMap.values())
                                        .sort((a, b) => b.combinedScore - a.combinedScore)
                                        .slice(0, k_final);

            finalRankedDocuments.forEach(item => uniqueRetrievedTexts.add(item.text));

            retrievedContext = Array.from(uniqueRetrievedTexts).join('\n\n');
            console.log(`Retrieved combined context for ${chatType} chat (Case ${caseId}):\n`, retrievedContext);
        }
    }

    const augmentedMessages = [
        { role: 'system', content: systemPromptFromFrontend },
    ];

    if (retrievedContext) {
        augmentedMessages.push({ role: 'system', content: `Here is additional relevant background information and details from the patient interaction or teaching materials:\n${retrievedContext}` });
    }

    if (chatType === 'physician') {
        if (rawPatientTranscriptForLLM) {
            augmentedMessages.push(rawPatientTranscriptForLLM);
        }
        if (performanceAnalysisResult) {
            augmentedMessages.push({ role: 'system', content: `Here is a summary of the student's history-taking performance during the patient interaction:\n${performanceAnalysisResult.summary}` });
        }
    }

    augmentedMessages.push(...actualConversationHistory);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: augmentedMessages,
    });

    res.json({ reply: completion.choices[0].message });
  } catch (error) {
    console.error('OpenAI error:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

// IMPORTANT: This module.exports line is CRUCIAL for main.js to import this file
module.exports = app;