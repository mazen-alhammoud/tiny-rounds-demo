// js/main.js (UPDATED for Electron IPC to fetch patient_cases.json via backend)

document.addEventListener('DOMContentLoaded', () => {
    const mainContentContainer = document.getElementById('main-content');
    const loadingIndicator = document.getElementById('loading-indicator');

    // Function to fetch patient cases using Electron IPC
    async function fetchPatientCases() {
        if (loadingIndicator) {
            loadingIndicator.style.display = 'block'; // Ensure loading indicator is visible
        }
        try {
            // Use the electronAPI to send a request to the main process
            // The main process will then call your Express backend's new endpoint
            // to get the patient_cases.json content.
            const data = await window.electronAPI.sendRequest('get-all-patient-cases');

            if (data.error) {
                throw new Error(data.error);
            }
            return data.cases; // Assuming the backend sends back an object like { cases: [...] }
        } catch (error) {
            console.error('Failed to fetch patient cases via Electron API:', error);
            mainContentContainer.innerHTML = '<p class="error-message">Failed to load patient cases. Please try again later.</p>';
            return [];
        } finally {
            if (loadingIndicator) {
                loadingIndicator.style.display = 'none'; // Hide loading indicator
            }
        }
    }

    // Function to render patient cases grouped by specialty
    async function renderPatientCases() {
        const patientCases = await fetchPatientCases();

        if (patientCases.length === 0) {
            if (!mainContentContainer.querySelector('.error-message')) {
                mainContentContainer.innerHTML = '<p>No patient cases found.</p>';
            }
            return;
        }

        // 1. Group cases by specialty
        const casesBySpecialty = patientCases.reduce((acc, currentCase) => {
            const specialty = currentCase.specialty || 'General Pediatrics'; // Default if specialty is missing
            if (!acc[specialty]) {
                acc[specialty] = [];
            }
            acc[specialty].push(currentCase);
            return acc;
        }, {});

        // Clear previous content in mainContentContainer
        mainContentContainer.innerHTML = '';

        // 2. Iterate through specialties and create sections
        for (const specialtyName in casesBySpecialty) {
            if (casesBySpecialty.hasOwnProperty(specialtyName)) {
                const specialtyCases = casesBySpecialty[specialtyName];

                // Create section for the specialty
                const sectionContainer = document.createElement('section');
                sectionContainer.classList.add('section-container');

                const sectionTitle = document.createElement('h2');
                sectionTitle.classList.add('section-title');
                sectionTitle.textContent = specialtyName;
                sectionContainer.appendChild(sectionTitle);

                // Create main container for scenarios within this section
                const scenarioContainer = document.createElement('main'); // Using main for semantic reasons for internal content
                scenarioContainer.id = `scenario-container-${specialtyName.replace(/\s+/g, '-').toLowerCase()}`; // Unique ID
                scenarioContainer.setAttribute('aria-live', 'polite');
                scenarioContainer.setAttribute('aria-atomic', 'true');
                sectionContainer.appendChild(scenarioContainer);

                // Append the section to the main content area
                mainContentContainer.appendChild(sectionContainer);

                // 3. Populate each specialty section with its cases
                specialtyCases.forEach(patientCase => {
                    const scenarioCard = createScenarioCard(patientCase); // Re-use your existing function
                    scenarioContainer.appendChild(scenarioCard);
                });
            }
        }
    }

    function createScenarioCard(patientCase) {
        const card = document.createElement('div');
        card.classList.add('card'); // Your existing .card class for styling
        card.setAttribute('data-id', patientCase.id);

        // Create an anchor tag that wraps the entire card content
        const cardLink = document.createElement('a');
        cardLink.href = `scenario.html?case_id=${patientCase.id}`; // The entire card will navigate
        cardLink.classList.add('card-link'); // Add a class for potential styling (e.g., remove underline)

        const cardContent = document.createElement('div');
        cardContent.classList.add('card-content');

        const title = document.createElement('h3');
        title.textContent = patientCase.title;
        cardContent.appendChild(title);

        const description = document.createElement('p');
        description.textContent = patientCase.summary;
        cardContent.appendChild(description);

        cardLink.appendChild(cardContent); // Append cardContent to the link
        card.appendChild(cardLink);       // Append the link to the card div

        return card;
    }

    // Initial call to render cases when the page loads
    renderPatientCases();
});