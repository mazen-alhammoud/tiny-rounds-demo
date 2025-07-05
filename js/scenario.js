// ~/Desktop/tiny-rounds-demo/js/scenario.js (RECONSTRUCTED FOR OLD FUNCTIONALITY + IPC)

let patientChatHistory = []; // Separate history for patient interaction
let attendingChatHistory = []; // Separate history for attending interaction
let currentCaseId = null;
let patientAIPrompt = "";
let attendingAIPrompt = "";
let patientTranscript = ""; // To store the raw patient transcript for attending
let currentChatType = 'patient'; // 'patient' or 'physician'

document.addEventListener('DOMContentLoaded', async () => {
    // Elements - Matched to your detailed scenario.html
    const caseTitleEl = document.getElementById('case-title');
    const caseSummaryEl = document.getElementById('case-summary');

    const btnPatient = document.getElementById('btn-patient');
    const btnPhysician = document.getElementById('btn-physician');

    const patientChatWindow = document.getElementById('patient-chat-window');
    const physicianChatWindow = document.getElementById('physician-chat-window');

    const patientMessagesEl = document.getElementById('patient-messages');
    const physicianMessagesEl = document.getElementById('physician-messages');

    const patientForm = document.getElementById('patient-chat-form');
    const physicianForm = document.getElementById('physician-chat-form');

    const patientInput = document.getElementById('patient-chat-input');
    const patientSendButton = patientForm.querySelector('button[type="submit"]');

    const physicianInput = document.getElementById('physician-chat-input');
    const physicianSendButton = physicianForm.querySelector('button[type="submit"]');

    const statusDiv = document.getElementById('status-message'); // For general status messages

    // Export Buttons
    const exportPatientBtn = document.getElementById('export-patient-conversation-btn');
    const exportPhysicianBtn = document.getElementById('export-physician-conversation-btn');

    // Typing Indicator Elements
    const patientTypingIndicator = document.getElementById('patient-typing-indicator');
    const physicianTypingIndicator = document.getElementById('physician-typing-indicator');


    const urlParams = new URLSearchParams(window.location.search);
    currentCaseId = urlParams.get('case_id'); // Correct parameter name from your index.html links

    // Initial UI state - disable inputs until data is loaded
    patientInput.disabled = true;
    patientSendButton.disabled = true;
    physicianInput.disabled = true;
    physicianSendButton.disabled = true;

    if (currentCaseId) {
        console.log(`Loading scenario for case: ${currentCaseId}`);
        displayStatusMessage(`Loading case ${currentCaseId}...`);

        // Load specific case data and initialize chat
        try {
            await loadCaseData(currentCaseId); // Loads title, summary, and system prompts
            await preloadCaseData(currentCaseId); // Preload backend RAG data
            initializeChat(); // Displays initial patient message
            displayStatusMessage('Case loaded and ready!', false);
        } catch (error) {
            console.error("Error during initial setup:", error);
            caseTitleEl.textContent = 'Error Loading Case';
            caseSummaryEl.textContent = 'Failed to load case data. Check console for details.';
            displayStatusMessage(`Error: ${error.message}`, true);
        }
    } else {
        caseTitleEl.textContent = 'No Case Selected';
        caseSummaryEl.textContent = 'Please go back to the home page and select a case.';
        displayStatusMessage('Error: No case ID provided in URL.', true);
        patientMessagesEl.innerHTML = '<p>Error: No case selected.</p>';
        physicianMessagesEl.innerHTML = '<p>Error: No case selected.</p>';
    }

    // --- Event Listeners for Forms and Buttons ---
    document.getElementById('patient-chat-form').addEventListener('submit', (e) => {
        e.preventDefault();
        sendMessage('patient');
    });

    document.getElementById('physician-chat-form').addEventListener('submit', (e) => {
        e.preventDefault();
        sendMessage('physician');
    });

    document.getElementById('btn-patient').addEventListener('click', () => {
        switchChatView('patient');
    });
    document.getElementById('btn-physician').addEventListener('click', () => {
        switchChatView('physician');
    });

    // Event Listeners for the export buttons
    if (exportPatientBtn) {
        exportPatientBtn.addEventListener('click', () => {
            exportConversation(patientChatHistory, 'patient');
        });
    }

    if (exportPhysicianBtn) {
        exportPhysicianBtn.addEventListener('click', () => {
            exportConversation(attendingChatHistory, 'attending');
        });
    }

    // Initial view setup
    switchChatView('patient'); // Activates patient chat and enables its input
});

// Helper function to display temporary status messages
function displayStatusMessage(message, isError = false) {
    const statusDiv = document.getElementById('status-message');
    if (statusDiv) {
        statusDiv.textContent = message;
        statusDiv.style.color = isError ? 'red' : 'green';
        statusDiv.style.display = 'block';
        setTimeout(() => {
            statusDiv.style.display = 'none';
        }, 5000); // Hide after 5 seconds
    } else {
        console.warn('Status message element not found, logging:', message);
    }
}


// --- Core Data Loading Functions (Now using IPC) ---
async function loadCaseData(caseId) {
    const caseTitleEl = document.getElementById('case-title');
    const caseSummaryEl = document.getElementById('case-summary');

    try {
        // IPC call to get specific case details from patient_cases.json
        const scenario = await window.electronAPI.sendRequest('get-case-details', caseId);
        if (scenario.error) {
            throw new Error(scenario.error);
        }

        if (!scenario) throw new Error(`Scenario with ID ${caseId} not found.`);

        caseTitleEl.textContent = scenario.title;
        caseSummaryEl.textContent = scenario.summary;

        // IPC call to fetch patient-specific system prompt
        const patientData = await window.electronAPI.sendRequest('get-case-file', { caseId, type: 'patient' });
        if (patientData.error) {
            throw new Error(`Error fetching patient case file: ${patientData.error}`);
        }
        if (patientData && patientData.system_prompt) {
            patientAIPrompt = patientData.system_prompt;
            // ADDED LOG: Check patient prompt after loading
            console.log("Loaded Patient AI Prompt (first 100 chars):", patientAIPrompt.substring(0, 100) + "...");
        } else {
            console.warn(`System prompt not found for patient case ${caseId}.`);
        }

        // IPC call to fetch physician-specific system prompt
        const physicianData = await window.electronAPI.sendRequest('get-case-file', { caseId, type: 'physician' });
        if (physicianData.error) {
            throw new Error(`Error fetching physician case file: ${physicianData.error}`);
        }
        if (physicianData && physicianData.system_prompt) {
            attendingAIPrompt = physicianData.system_prompt;
            // ADDED LOG: Check attending prompt after loading
            console.log("Loaded Attending AI Prompt (first 100 chars):", attendingAIPrompt.substring(0, 100) + "...");
        } else {
            console.warn(`System prompt not found for physician case ${caseId}.`);
        }

        console.log("Case metadata and system prompts loaded successfully via IPC.");
    } catch (error) {
        console.error("Error loading case data via IPC:", error);
        displayStatusMessage(`Failed to load scenario data: ${error.message}`, true);
        throw error; // Re-throw to be caught by DOMContentLoaded error handling
    }
}

async function preloadCaseData(caseId) {
    try {
        displayStatusMessage(`Pre-loading case data for AI...`);
        const response = await window.electronAPI.sendRequest('preload-case-data', { caseId });
        if (response.error) {
            throw new Error(response.error);
        }
        console.log("Backend preloading initiated:", response.message);
        displayStatusMessage(`Pre-loading complete: ${response.message}`, false);
    } catch (error) {
        console.error("Error preloading case data via IPC:", error);
        displayStatusMessage(`Failed to preload case data for AI: ${error.message}`, true);
        throw error; // Re-throw to be caught by DOMContentLoaded error handling
    }
}

function initializeChat() {
    // Initial patient greeting
    appendMessage('Hi Doctor. (fidgets with hands)', 'patient', 'patient-messages');
    patientChatHistory.push({ role: 'assistant', content: 'Hi Doctor. (fidgets with hands)' });
    updateChatInputState(); // Set initial input states
}

function switchChatView(type) {
    currentChatType = type;
    const patientChatWindow = document.getElementById('patient-chat-window');
    const physicianChatWindow = document.getElementById('physician-chat-window');
    const btnPatient = document.getElementById('btn-patient');
    const btnPhysician = document.getElementById('btn-physician');

    if (type === 'patient') {
        patientChatWindow.classList.add('active');
        physicianChatWindow.classList.remove('active');
        btnPatient.classList.add('active');
        btnPhysician.classList.remove('active');
        // Clear input when switching
        document.getElementById('patient-chat-input').value = '';
        document.getElementById('physician-chat-input').value = ''; // Clear other input too

        const chatDisplay = document.getElementById('patient-messages');
        chatDisplay.scrollTop = chatDisplay.scrollHeight;
    } else {
        patientChatWindow.classList.remove('active');
        physicianChatWindow.classList.add('active');
        btnPatient.classList.remove('active');
        btnPhysician.classList.add('active');
        // Clear input when switching
        document.getElementById('patient-chat-input').value = '';
        document.getElementById('physician-chat-input').value = ''; // Clear other input too

        const chatDisplay = document.getElementById('physician-messages');
        chatDisplay.scrollTop = chatDisplay.scrollHeight;
    }
    updateChatInputState();
}

function updateChatInputState() {
    const patientInput = document.getElementById('patient-chat-input');
    const physicianInput = document.getElementById('physician-chat-input');
    const patientFormBtn = document.querySelector('#patient-chat-form button[type="submit"]');
    const physicianFormBtn = document.querySelector('#physician-chat-form button[type="submit"]');

    if (currentChatType === 'patient') {
        patientInput.disabled = false;
        patientInput.focus();
        patientFormBtn.disabled = false;
        patientInput.placeholder = "Ask the patient...";

        physicianInput.disabled = true;
        physicianFormBtn.disabled = true;
    } else {
        patientInput.disabled = true;
        patientFormBtn.disabled = true;

        physicianInput.disabled = false;
        physicianInput.focus();
        physicianFormBtn.disabled = false;
        physicianInput.placeholder = "Ask the attending physician...";
    }
}

function appendMessage(message, sender, displayId) {
    const chatDisplay = document.getElementById(displayId);
    const messageElement = document.createElement('div');
    messageElement.classList.add('chat-message', `${sender}-message`);
    messageElement.textContent = message;
    chatDisplay.appendChild(messageElement);
    chatDisplay.scrollTop = chatDisplay.scrollHeight;
}

// Function to handle sending messages to the AI via IPC
async function sendMessage(chatType) {
    let userInputElement;
    let chatDisplayId;
    let sendButtonElement;
    let typingIndicatorElement;

    if (chatType === 'patient') {
        userInputElement = document.getElementById('patient-chat-input');
        chatDisplayId = 'patient-messages';
        sendButtonElement = document.querySelector('#patient-chat-form button[type="submit"]');
        typingIndicatorElement = document.getElementById('patient-typing-indicator');
    } else if (chatType === 'physician') {
        userInputElement = document.getElementById('physician-chat-input');
        chatDisplayId = 'physician-messages';
        sendButtonElement = document.querySelector('#physician-chat-form button[type="submit"]');
        typingIndicatorElement = document.getElementById('physician-typing-indicator');
    } else {
        console.error("Invalid chat type provided to sendMessage.");
        return;
    }

    const message = userInputElement.value.trim();
    if (!message) return;

    appendMessage(message, 'student', chatDisplayId);
    userInputElement.value = '';

    // Disable input and show typing/loading indicator
    userInputElement.disabled = true;
    sendButtonElement.disabled = true;
    if (typingIndicatorElement) {
        typingIndicatorElement.style.display = 'flex'; // Use flex to show dots
    }
    displayStatusMessage(`AI is thinking...`);


    let currentMessages = [];
    let systemPrompt = "";

    if (chatType === 'patient') {
        patientChatHistory.push({ role: 'user', content: message });
        currentMessages = [...patientChatHistory];
        systemPrompt = patientAIPrompt;

        // Update patient transcript for the attending physician
        patientTranscript += `Student: ${message}\n`;

        // Prepare messages for patient AI (including system prompt)
        const messagesForPatientAI = [{ role: 'system', content: systemPrompt }, ...currentMessages];
        // ADDED LOG: Check system prompt before sending to Patient AI
        console.log("Sending to Patient AI. System Prompt (first 100 chars):", messagesForPatientAI[0].content.substring(0, 100) + "...");


        try {
            const response = await window.electronAPI.sendRequest('chat', {
                messages: messagesForPatientAI,
                chatType: 'patient',
                caseId: currentCaseId
            });

            if (response.error) {
                throw new Error(response.error);
            }

            const botReply = response.reply.content;
            appendMessage(botReply, 'patient', chatDisplayId);
            patientChatHistory.push({ role: 'assistant', content: botReply });
            patientTranscript += `Patient: ${botReply}\n`; // Append patient's reply to transcript

        } catch (error) {
            console.error('Error getting patient chat response:', error);
            appendMessage('Error: Could not get response from patient AI.', 'system', chatDisplayId);
            displayStatusMessage(`Error: ${error.message}`, true);
        } finally {
            if (typingIndicatorElement) {
                typingIndicatorElement.style.display = 'none';
            }
            userInputElement.disabled = false;
            sendButtonElement.disabled = false;
            userInputElement.focus();
            displayStatusMessage(''); // Clear status message
        }

    } else if (chatType === 'physician') {
        attendingChatHistory.push({ role: 'user', content: message });
        currentMessages = [...attendingChatHistory];
        systemPrompt = attendingAIPrompt; // This should be the attending physician's prompt

        const messagesForAttendingAI = [
            { role: 'system', content: systemPrompt },
            { role: 'system', content: `Here is the transcript of your interaction with the patient:\n\n${patientTranscript}` },
            ...currentMessages
        ];
        // ADDED LOG: Check system prompt before sending to Attending AI
        console.log("Sending to Attending AI. System Prompt (first 100 chars):", messagesForAttendingAI[0].content.substring(0, 100) + "...");
        console.log("Sending to Attending AI. Patient Transcript (first 100 chars):", messagesForAttendingAI[1].content.substring(0, 100) + "...");


        try {
            const response = await window.electronAPI.sendRequest('chat', {
                messages: messagesForAttendingAI,
                chatType: 'physician',
                caseId: currentCaseId
            });

            if (response.error) {
                throw new Error(response.error);
            }

            const botReply = response.reply.content;
            appendMessage(botReply, 'attending', chatDisplayId);
            attendingChatHistory.push({ role: 'assistant', content: botReply });

        } catch (error) {
            console.error('Error getting attending chat response:', error);
            appendMessage('Error: Could not get response from attending AI.', 'system', chatDisplayId);
            displayStatusMessage(`Error: ${error.message}`, true);
        } finally {
            if (typingIndicatorElement) {
                typingIndicatorElement.style.display = 'none';
            }
            userInputElement.disabled = false;
            sendButtonElement.disabled = false;
            userInputElement.focus();
            displayStatusMessage(''); // Clear status message
        }
    }
}

// Function to export conversation using Electron IPC
function exportConversation(conversationArray, filenamePrefix) {
    let exportText = '';
    conversationArray.forEach(message => {
        const senderLabel = message.role === 'user' ? 'You' : (message.role === 'assistant' ? (filenamePrefix === 'patient' ? 'Patient' : 'Attending Physician') : 'System');
        exportText += `${senderLabel}: ${message.content}\n\n`;
    });

    // Use Electron IPC to trigger a file save dialog in the main process
    window.electronAPI.sendRequest('save-file', {
        content: exportText,
        defaultPath: `${filenamePrefix}_conversation_${currentCaseId}_${new Date().toISOString().slice(0,10)}.txt`,
        title: `Export ${filenamePrefix} Conversation`
    })
    .then(response => {
        if (response.success) {
            displayStatusMessage(`Conversation saved to: ${response.filePath}`, false);
        } else if (response.error) {
            displayStatusMessage(`Error saving file: ${response.error}`, true);
        } else {
            displayStatusMessage('File save cancelled.', false);
        }
    })
    .catch(err => {
        console.error('Error calling save-file IPC:', err);
        displayStatusMessage(`Internal error during export: ${err.message}`, true);
    });
}