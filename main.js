// main.js (CORRECTED: Added dialog, fs, and save-file IPC handler)

// --- Crucial requires for file saving and dialogs ---
const { app, BrowserWindow, ipcMain, dialog } = require('electron'); // ADDED 'dialog' here
const path = require('path');
const fs = require('fs').promises; // ADDED fs.promises here

// --- Require your Express app ---
const expressApp = require('./backend/server'); // Path to your backend/server.js
let expressServer; // To hold the Express server instance

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), // Use a preload script for security
      nodeIntegration: false, // Keep false for security
      contextIsolation: true, // Keep true for security
      webSecurity: true,
    }
  });

  // Load your index.html file (the home page for case selection)
  mainWindow.loadFile('index.html');

  // Open the DevTools (useful for debugging)
  // mainWindow.webContents.openDevTools();

  // --- Start the Express server within Electron's main process ---
  // We'll use a dynamic port (0) so it's assigned an available port automatically.
  expressServer = expressApp.listen(0, () => {
    const { port } = expressServer.address();
    console.log(`Internal Express server running on http://localhost:${port}`);
  });
}

// --- IPC Handlers: Listen for specific messages from the renderer process (your frontend) ---
// These handlers will directly correspond to the 'channel' names sent by preload.js
// and simulate API calls to your internal Express app.

// Handle 'chat' requests
ipcMain.handle('chat', async (event, data) => {
    try {
        const internalUrl = `http://localhost:${expressServer.address().port}/api/chat`;
        const response = await global.fetch(internalUrl, { // Use global.fetch
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Internal API error: ${response.status} - ${errorData.error || 'Unknown error'}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Error in IPC handler for 'chat':`, error);
        return { error: error.message || 'Failed to process chat request internally' };
    }
});

// Handle 'preload-case-data' requests (for loading a specific case's RAG data)
ipcMain.handle('preload-case-data', async (event, data) => {
    try {
        const internalUrl = `http://localhost:${expressServer.address().port}/api/preload-case-data`;
        const response = await global.fetch(internalUrl, { // Use global.fetch
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Internal API error: ${response.status} - ${errorData.error || 'Unknown error'}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Error in IPC handler for 'preload-case-data':`, error);
        return { error: error.message || 'Failed to preload case data internally' };
    }
});

// Handle 'get-all-patient-cases' requests (for index.html)
ipcMain.handle('get-all-patient-cases', async (event) => {
    try {
        const internalUrl = `http://localhost:${expressServer.address().port}/api/patient-cases`;
        const response = await global.fetch(internalUrl); // Use global.fetch
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Internal API error: ${response.status} - ${errorData.error || 'Unknown error'}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Error in IPC handler for 'get-all-patient-cases':`, error);
        return { error: error.message || 'Failed to get patient cases internally' };
    }
});

// NEW IPC Handler: get a specific case's details from patient_cases.json
ipcMain.handle('get-case-details', async (event, caseId) => {
    try {
        const internalUrl = `http://localhost:${expressServer.address().port}/api/case-details/${caseId}`;
        const response = await global.fetch(internalUrl);
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Internal API error: ${response.status} - ${errorData.error || 'Unknown error'}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Error in IPC handler for 'get-case-details' (Case ID: ${caseId}):`, error);
        return { error: error.message || 'Failed to get specific case details internally' };
    }
});

// NEW IPC Handler: get content of specific case file (e.g., peds001_patient.json)
ipcMain.handle('get-case-file', async (event, { caseId, type }) => {
    try {
        const internalUrl = `http://localhost:${expressServer.address().port}/api/case-file/${caseId}/${type}`;
        const response = await global.fetch(internalUrl);
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Internal API error: ${response.status} - ${errorData.error || 'Unknown error'}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Error in IPC handler for 'get-case-file' (Case ID: ${caseId}, Type: ${type}):`, error);
        return { error: error.message || `Failed to get case file for ${caseId}_${type} internally` };
    }
});

// --- NEW IPC Handler: For saving files (used by export functionality) ---
ipcMain.handle('save-file', async (event, { content, defaultPath, title }) => {
    console.log('Main Process: Received save-file request.'); // Debug log 1
    const webContents = event.sender;
    const mainWindow = BrowserWindow.fromWebContents(webContents);

    try {
        console.log(`Main Process: Attempting to show save dialog. Default path: ${defaultPath}`); // Debug log 2
        const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
            title: title || 'Save Conversation',
            defaultPath: defaultPath || 'conversation.txt',
            filters: [
                { name: 'Text Files', extensions: ['txt'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (canceled) {
            console.log('Main Process: Save dialog cancelled by user.'); // Debug log 3
            return { success: false, error: 'User cancelled file save.' };
        }

        if (filePath) {
            console.log(`Main Process: File path selected: ${filePath}`); // Debug log 4
            await fs.writeFile(filePath, content, 'utf-8');
            console.log('Main Process: File successfully written.'); // Debug log 5
            return { success: true, filePath: filePath };
        } else {
            console.log('Main Process: No file path selected despite not being cancelled.'); // Debug log 6 (unlikely but good to have)
            return { success: false, error: 'No file path selected.' };
        }
    } catch (error) {
        console.error('Main Process: Error saving file in main process:', error); // Debug log 7
        return { success: false, error: error.message };
    }
});


// App lifecycle events
app.whenReady().then(async () => {
  // --- Install node-fetch in the main process ---
  // This allows the main process to use `fetch` for internal HTTP calls
  global.fetch = (await import('node-fetch')).default;

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// --- Gracefully close the internal Express server when the app quits ---
app.on('will-quit', () => {
  if (expressServer) {
    expressServer.close(() => {
      console.log('Internal Express server closed.');
    });
  }
});