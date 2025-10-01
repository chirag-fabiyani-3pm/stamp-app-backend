const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Use the same vector store ID as in Next.js api/philaguide-v2/working
const VECTOR_STORE_ID = 'vs_68a700c721648191a8f8bd76ddfcd860';

// Session management for context - maps sessionId to previousResponseId
const activeSessions = new Map();

// Request deduplication - prevent multiple identical requests
const activeRequests = new Map(); // requestKey -> Promise

async function handlePhilaguideV2Working(req, res) {
    let requestKey;
    try {
        const { message, sessionId, isVoiceChat = false } = req.body || {};

        // Basic input validation
        if (!message || typeof message !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Message is required and must be a string'
            });
        }

        if (message.length > 2000) {
            return res.status(400).json({
                success: false,
                error: 'Message is too long. Please keep your questions under 2000 characters.'
            });
        }

        if (!sessionId || typeof sessionId !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Session ID is required'
            });
        }

        console.log('🚀 Working Philaguide V2 API called with:', {
            message: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
            sessionId,
            isVoiceChat,
            hasPreviousContext: activeSessions.has(sessionId)
        });

        // Create request key for deduplication - use session and message content only
        const messageKey = `${sessionId}:${message.trim().toLowerCase()}`;

        // Check if identical request is already in progress
        if (activeRequests.has(messageKey)) {
            console.log('🔄 Duplicate request detected, returning existing promise');
            const existingPromise = activeRequests.get(messageKey);
            const result = await existingPromise;
            return res.json(result);
        }

        // Create a unique request key for this specific request
        requestKey = `${messageKey}:${Date.now()}`;

        // Clean up old requests (older than 60 seconds)
        const now = Date.now();
        for (const key of activeRequests.keys()) {
            const keyParts = key.split(':');
            const requestTime = parseInt(keyParts[keyParts.length - 1] || '0', 10);
            if (now - requestTime > 60000) {
                activeRequests.delete(key);
                console.log('🧹 Cleaned up old request:', key);
            }
        }

        // Get previous response ID for conversation context
        const previousResponseId = activeSessions.get(sessionId);
        if (previousResponseId) {
            console.log('📚 Using conversation context from:', previousResponseId);
        } else {
            console.log('🆕 Starting new conversation session');
        }

        // Create the request promise and store it for deduplication
        const requestPromise = (async () => {
            try {
                // DEBUG: Log the search query and tools being used
                console.log('🔍 DEBUG: Starting search with query:', message)
                console.log('🔍 DEBUG: Using tools:', [
                    { type: 'file_search', vector_store_ids: [VECTOR_STORE_ID] }
                ])
                console.log('🔍 DEBUG: Vector store ID:', VECTOR_STORE_ID)

                // Create response with vector store access, context, and structured output
                const response = await openai.responses.create({
                    model: 'gpt-4o',
                    input: message,
                    temperature: 0,
                    max_output_tokens: 1800,
                    instructions: `
# ROLE & PERSONALITY

You are PhilaGuide AI, a world-class philatelic expert.
Be precise, conversational, educational, and patient.

# ABSOLUTE RULES

- Never mention: uploaded files, databases, vector stores, retrieval mechanics, isInstance, or parentStampId
- Never fabricate or mix fields
- Cards only when all Primary Fields exist
- Base-first rule: if varieties exist, always show the base issue first, then varieties
- COMPARISON REQUESTS: When user asks to "compare", "compare both", or "show comparison" → Return ONLY JSON with mode: "comparison" (NO text, NO explanations)

# VARIETY HANDLING

## Identifying
- **Base Stamp**: stamp_metadata.isInstance = false (or missing)
- **Variety**: stamp_metadata.isInstance = true
- **Link**: Each variety has a parentStampId → use this to locate its base stamp

## Rules
- Never display a variety without its base
- If query mentions a variety, first locate its parentStampId record and show that base stamp
- Then display the variety (and other related varieties if relevant)

## Series-level queries (e.g., "King Edward VII stamps")
- Do not show varieties immediately
- Ask clarifying questions (denomination, year, catalog #)
- Show base issues first; varieties only if the user specifies

## Order in Carousels
- Always Base → Varieties
- Max 4 cards total

## Labeling
In the Description field, explicitly state:
- **Base**: "This is the base issue."
- **Variety**: "This is a variety of the [base stamp name], differing by [shade/watermark/etc.]."

⚠️ Never expose parentStampId in the response — it is an internal linking field only.

# RESPONSE DECISION LOGIC (MODE SELECTION)

## Precision
- **High** (exact identifiers: catalog #, or year + denomination, or explicit unique ID) → mode = "cards"
- **Medium** (monarch/era, theme, country + broad info) → mode = "clarify" and ask ≤2 contextual questions. Do NOT output cards in the same response
- **Low** (very vague) → mode = "educational" with helpful guidance. Do NOT output cards

## Cards vs Normal Text
- **Cards**: Only when mode = "cards" and all Primary fields exist for each record
- **Normal Text**: philatelic knowledge, value/rarity queries, broad themes, collecting practices (mode = "educational")

# CARD BUILDING

## Primary (Required)
- **Stamp Name** ← stamp_core.name
- **Country** ← countryName
- **ID** ← id (not stampId)
- **Image URL** ← stampImageUrl (if missing/empty → /images/stamps/no-image-available.png)

## Secondary (Optional, from same record only)
- **Description** (combine description fields)
- **Series** ← seriesName
- **Year** ← issueYear
- **Denomination** ← denominationDisplay
- **Catalog Number** ← catalogNumber
- **Theme** ← combine theme, subject
- **Technical Details** ← combine technical fields

**Rule**: One record per card. No mixing.

# RESULT QUANTITY

- 1 base stamp → Single Card
- 1 base + varieties → Base card first, then up to 3 varieties (max 4 total)
- 2–4 bases → Carousel of bases only (no varieties unless specified)
- 5+ bases → Carousel of top 4 bases
- 0 matches → Clarifying questions or educational text

# OUTPUT FORMATS

## Card (single)
\`\`\`
## Stamp Information
**Stamp Name**: [value]
**Country**: [value]
**ID**: [value]
**Image URL**: [value]
**Description**: [value]
**Series**: [value]
**Year**: [value]
**Denomination**: [value]
**Catalog Number**: [value]
**Theme**: [value]
**Technical Details**: [value]
\`\`\`

## Carousel (2–4)
Repeat the block above for each card (Base first, then Varieties).

## Comparison
When user asks to compare stamps, return ONLY this JSON format (NO markdown, NO text, NO explanations):
{
  "mode": "comparison",
  "stampIds": ["[stampId1]", "[stampId2]", "[stampId3]"]
}

CRITICAL: For comparison requests, do NOT provide text descriptions or explanations. ONLY return the JSON structure above.

## Clarifying Questions

- Ask up to 2 clarifying questions only when the query is ambiguous
- Questions must be dynamic and contextual, not word-for-word copies
- Phrase them conversationally and vary wording so they don't sound robotic
- Pick the most relevant attributes for that query (country, monarch, denomination, year, catalog number, variety type)

### Examples of Good Clarifying Questions
*(Never repeat verbatim; adapt to query):*

- "Do you mean the whole King Edward VII series, or a particular value like the 1d red?"
- "Which country's Queen Victoria issue are you interested in — Britain, Canada, or somewhere else?"
- "Are you looking for the base stamp, or one of the shade/watermark varieties?"
- "Do you recall the year or denomination of the issue you saw?"

**Rule**: Always vary the wording. The AI should never output the same pair of clarifying questions in identical format for different queries

# OUTPUT CONTRACT
- You must output a JSON object that adheres strictly to the provided schema
- When mode = "clarify", populate "clarifyingQuestions" (1–2 items) and leave "cards" empty
- When mode = "cards", populate up to 4 card objects (Base first, then Varieties) and leave "clarifyingQuestions" empty
- When mode = "comparison", populate "stampIds" array and leave "cards" and "clarifyingQuestions" empty
- When mode = "educational", populate "educationalText" and leave "cards" and "clarifyingQuestions" empty

## Educational Text
Use for general/value/knowledge queries.
`,
                    tools: [
                        { type: 'file_search', vector_store_ids: [VECTOR_STORE_ID] }
                    ],
                    // Add conversation context if available
                    ...(previousResponseId && { previous_response_id: previousResponseId })
                })

                // DEBUG: Log the OpenAI response details
                console.log('🔍 DEBUG: OpenAI Response received:')
                console.log('Response ID:', response.id)
                console.log('Response status:', response.status)
                console.log('Response output type:', response.output?.[0]?.type)

                // DEBUG: Check if file_search was used
                if (response.output && response.output.length > 0) {
                    console.log('🔍 DEBUG: Response output details:')
                    response.output.forEach((output, index) => {
                        console.log(`Output ${index}:`, {
                            type: output.type,
                            hasContent: !!output,
                            outputDetails: output
                        })
                    })
                }

                // Build normalized content text and structured field using Assistants-style JSON in output_text if present
                let structured = null
                let contentText = response.output_text

                // Try to extract a JSON object from the output text (defensive)
                const jsonStart = response.output_text.indexOf('{')
                const jsonEnd = response.output_text.lastIndexOf('}')
                if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
                    const possibleJson = response.output_text.slice(jsonStart, jsonEnd + 1)
                    try {
                        const parsed = JSON.parse(possibleJson)
                        if (parsed && typeof parsed === 'object' && parsed.mode) {
                            structured = parsed
                        }
                    } catch (e) {
                        // ignore
                    }
                }

                // Fallback: Try to extract comparison data from text response for compare requests
                if (!structured && (response.output_text.toLowerCase().includes('compare') ||
                    response.output_text.toLowerCase().includes('comparison'))) {

                    console.log('🔧 Attempting to extract comparison data from text response')

                    // Try to extract stamp IDs from the text response
                    const stampIdMatches = response.output_text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi)

                    if (stampIdMatches && stampIdMatches.length > 0) {
                        structured = {
                            mode: "comparison",
                            stampIds: stampIdMatches.slice(0, 3) // Limit to 3 stamps
                        }

                        console.log('✅ Successfully extracted comparison data from text:', structured)
                    }
                }

                if (structured && typeof structured === 'object' && structured.mode) {
                    if (structured.mode === 'clarify' && Array.isArray(structured.clarifyingQuestions)) {
                        const questions = structured.clarifyingQuestions.filter(Boolean)
                        if (questions.length > 0) {
                            contentText = 'To narrow this down:\n' + questions.map((q) => `- ${q}`).join('\n')
                        }
                    } else if (structured.mode === 'cards' && Array.isArray(structured.cards)) {
                        const toCardBlock = (c) => [
                            '## Stamp Information',
                            `**Stamp Name**: ${c.stampName || ''}`,
                            `**Country**: ${c.country || ''}`,
                            `**ID**: ${c.id || ''}`,
                            `**Image URL**: ${c.imageUrl || '/images/stamps/no-image-available.png'}`,
                            `**Description**: ${c.description || ''}`,
                            `**Series**: ${c.series || ''}`,
                            `**Year**: ${c.year || ''}`,
                            `**Denomination**: ${c.denomination || ''}`,
                            `**Catalog Number**: ${c.catalogNumber || ''}`,
                            `**Theme**: ${c.theme || ''}`,
                            `**Technical Details**: ${c.technicalDetails || ''}`
                        ].join('\n')

                        const baseFirst = structured.cards.slice().sort((a, b) => (a.isBase === b.isBase) ? 0 : (a.isBase ? -1 : 1))
                        contentText = baseFirst.map(toCardBlock).join('\n\n')
                    } else if (structured.mode === 'comparison' && Array.isArray(structured.stampIds)) {
                        // Handle comparison requests
                        const stampIds = structured.stampIds.filter(Boolean)
                        if (stampIds.length > 0) {
                            contentText = `Opening comparison view for ${stampIds.length} stamp${stampIds.length > 1 ? 's' : ''}...`
                        }
                    } else if (structured.mode === 'educational' && typeof structured.educationalText === 'string') {
                        contentText = structured.educationalText
                    }
                }

                const result = {
                    success: true,
                    responseId: response.id,
                    content: contentText,
                    source: 'knowledge_base',
                    message: 'Response generated successfully!',
                    hasContext: !!previousResponseId,
                    structured
                };

                // Store the new response ID for future context
                activeSessions.set(sessionId, response.id);
                console.log('💾 Stored conversation context:', response.id);

                return result;
            } catch (error) {
                // Clean up the request from active requests on error
                activeRequests.delete(messageKey);
                throw error;
            }
        })();

        // Store the request promise for deduplication
        activeRequests.set(messageKey, requestPromise);

        // Wait for the request to complete
        const result = await requestPromise;

        // Clean up the request from active requests
        activeRequests.delete(messageKey);

        return res.json(result);
    } catch (error) {
        // Clean up the request from active requests on error
        if (requestKey) {
            activeRequests.delete(requestKey);
        }

        console.error('❌ Error in Working Philaguide V2 API:', error);
        console.error('❌ Error details:', {
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined,
            name: error instanceof Error ? error.name : undefined,
            type: typeof error
        });

        // Provide more user-friendly error messages
        let userErrorMessage = 'I encountered an error while processing your request. Please try again.';
        if (error instanceof Error) {
            if (error.message.includes('timeout') || error.message.includes('TIMEOUT')) {
                userErrorMessage = 'The request took too long to process. Please try a more specific question about stamps.';
            } else if (error.message.includes('rate limit') || error.message.includes('RATE_LIMIT')) {
                userErrorMessage = 'Too many requests at once. Please wait a moment and try again.';
            } else if (error.message.includes('vector_store') || error.message.includes('file_search')) {
                userErrorMessage = 'There was an issue accessing the stamp database. Please try again or ask a different question.';
            }
        }

        return res.status(500).json({
            success: false,
            error: userErrorMessage,
            technicalError: error instanceof Error ? error.message : 'Unknown error'
        });
    }
}

async function getPhilaguideV2WorkingStatus(req, res) {
    const sessionId = req.query.sessionId;
    if (sessionId) {
        const hasContext = activeSessions.has(sessionId);
        return res.json({
            sessionId,
            hasContext,
            previousResponseId: activeSessions.get(sessionId) || null
        });
    }

    return res.json({
        totalSessions: activeSessions.size,
        sessions: Array.from(activeSessions.keys())
    });
}

module.exports = {
    handlePhilaguideV2Working,
    getPhilaguideV2WorkingStatus,
};


