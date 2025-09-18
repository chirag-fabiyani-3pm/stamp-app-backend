const OpenAI = require('openai')

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

const VECTOR_STORE_ID = 'vs_68a700c721648191a8f8bd76ddfcd860'

// Session management for context - maps sessionId to previousResponseId
const activeSessions = new Map()

// Request deduplication - prevent multiple identical requests
const activeRequests = new Map()

async function handleVoiceVectorSearchRequest(req, res) {
    let requestKey

    try {
        const { transcript, sessionId, mode = 'precise' } = req.body || {}

        // Basic input validation
        if (!transcript || typeof transcript !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Transcript is required and must be a string'
            })
        }

        if (transcript.length > 2000) {
            return res.status(400).json({
                success: false,
                error: 'Transcript is too long. Please keep your questions under 2000 characters.'
            })
        }

        if (!sessionId || typeof sessionId !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Session ID is required'
            })
        }

        console.log('🎤 Voice vector search request:', {
            transcript: transcript.substring(0, 100) + (transcript.length > 100 ? '...' : ''),
            sessionId,
            mode,
            hasPreviousContext: activeSessions.has(sessionId)
        })

        // Create request key for deduplication
        const messageKey = `${sessionId}:${transcript.trim().toLowerCase()}`

        // Check if identical request is already in progress
        if (activeRequests.has(messageKey)) {
            console.log('🔄 Duplicate voice request detected, returning existing promise')
            return activeRequests.get(messageKey)
        }

        // Create a unique request key for this specific request
        requestKey = `${messageKey}:${Date.now()}`

        // Clean up old requests (older than 60 seconds)
        const now = Date.now()
        for (const [key, promise] of activeRequests.entries()) {
            const keyParts = key.split(':')
            const requestTime = parseInt(keyParts[keyParts.length - 1] || '0')
            if (now - requestTime > 60000) { // 60 seconds
                activeRequests.delete(key)
                console.log('🧹 Cleaned up old voice request:', key)
            }
        }

        // Get previous response ID for conversation context
        const previousResponseId = activeSessions.get(sessionId)

        if (previousResponseId) {
            console.log('📚 Using voice conversation context from:', previousResponseId)
        } else {
            console.log('🆕 Starting new voice conversation session')
        }

        // Create the request promise and store it for deduplication
        const requestPromise = (async () => {
            try {
                console.log('🔍 Voice search with query:', transcript)
                console.log('🔍 Using vector store ID:', VECTOR_STORE_ID)

                // Create response with vector store access and voice-optimized instructions
                const response = await openai.responses.create({
                    model: 'gpt-4o',
                    input: transcript,
                    temperature: 0,
                    max_output_tokens: 1000,
                    instructions: `
# ROLE & PERSONALITY
You are PhilaGuide AI, a world-class philatelic expert providing PRECISE, DATA-DRIVEN responses from the Campbell Peterson catalog.
When users ask for specific values, return EXACT information from the vector store. Be conversational but accurate.
# CRITICAL INSTRUCTIONS FOR PRECISE MODE
## VALUE QUERIES - HIGHEST PRIORITY
When users ask for mint values, prices, or worth:
1. SEARCH the vector store for exact matches based on the stamp description
2. If found, return the EXACT mintValue in NZD with currency symbol
3. Format: "The mint value for this stamp is $X NZD" (where X is the exact mintValue from the data)
4. Include additional context like denomination, year, series if available
5. NEVER give generic value ranges or estimates - use the actual data
## INSUFFICIENT INFORMATION HANDLING
When the stamp description is too vague to find a specific match:
1. Ask 2-3 SPECIFIC clarifying questions to narrow down the search
2. Focus on: denomination, year, country, series, color, or catalog number
3. Example: "To find the exact value, I need more details. What denomination was it? Do you know the year or series?"
## DATA EXTRACTION RULES
- Extract mintValue, finestUsedValue from matching records
- Use denominationDisplay, denominationDescription for denomination info
- Use colorName, colorDescription for color details
- Use issueYear, seriesName for temporal context
- Use catalogNumber when available
- Currency is always NZD (New Zealand Dollars) with $ symbol
# VOICE RESPONSE GUIDELINES
- Use clear, descriptive language suitable for speech
- Provide exact values when available: "The mint value is $500 NZD"
- Be conversational but precise
- When describing stamps, include denomination, year, color from the data
- Use natural language for denominations (e.g., "half penny" for "1/2d")
# RESPONSE MODES
## PRECISE VALUE RESPONSE
When exact stamp match found with mintValue:
"The mint value for the [denominationDescription] [colorName] stamp from [issueYear] is $[mintValue] NZD."
## CLARIFICATION NEEDED
When description is insufficient, return JSON format:
{
  "mode": "clarify",
  "clarifyingQuestions": [
    "What denomination was the stamp? For example, was it a penny, halfpenny, or another value?",
    "Do you know what year it was issued or what series it belonged to?"
  ]
}
## NO MATCH FOUND
When no matching stamp in vector store:
"I couldn't find that specific stamp in the Campbell Peterson catalog. Could you provide more details like the denomination, year, or catalog number?"
# SEARCH STRATEGY
1. Use the user's description to search the vector store for stamps with matching characteristics
2. Look for matches in: name, denominationDescription, colorName, seriesName, issueYear, catalogNumber
3. If SINGLE CLEAR MATCH found with mintValue > 0: provide exact value immediately
4. If MULTIPLE matches: ask clarifying questions to narrow down
5. If NO matches or vague description: ask for more specific details
6. Always prefer exact catalog data over estimates
# CRITICAL RESPONSE RULES
## FOR VALUE QUERIES:
- If exact match found: "The mint value for the [specific details] stamp is $[exact mintValue] NZD"
- If unclear which stamp: Ask 2-3 specific questions about denomination, year, color, series
- If no match: "I couldn't find that stamp in the Campbell Peterson catalog. Could you provide [specific details needed]?"
## NEVER DO:
- Give generic value ranges like "several hundred dollars"
- Make up values or provide estimates
- Give broad philatelic advice without specific catalog data
- Mention the vector store or database mechanics
## ALWAYS DO:
- Extract exact mintValue, finestUsedValue from matching records
- Use denominationDescription (e.g., "Half Penny") not codes (e.g., "1/2d")
- Include year, series, color from the actual stamp record
- Ask specific clarifying questions when description is ambiguous
# EXAMPLE RESPONSES
## Exact Match Found:
"The mint value for the Half Penny black stamp from 1897 (Second Sideface series) is $80 NZD."
## Need Clarification:
"To find the exact value, I need more specific details:
- What denomination was it? For example, was it a penny, halfpenny, or sixpence?
- Do you know what year it was issued or what color it was?"
## No Match:
"I couldn't find that specific stamp in the Campbell Peterson catalog. Could you provide the denomination, year, or any catalog numbers you might know?"
`,
                    tools: [
                        { type: 'file_search', vector_store_ids: [VECTOR_STORE_ID] }
                    ],
                    // Add conversation context if available
                    ...(previousResponseId && { previous_response_id: previousResponseId })
                })

                console.log('🔍 Voice search response received:', {
                    responseId: response.id,
                    status: response.status,
                    outputType: response.output?.[0]?.type
                })

                // Build normalized content text and structured field
                let structured = null
                let contentText = response.output_text

                // Try to extract a JSON object from the output text
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

                // Handle structured responses for precise mode
                if (structured && typeof structured === 'object' && structured.mode) {
                    if (structured.mode === 'clarify' && Array.isArray(structured.clarifyingQuestions)) {
                        const questions = structured.clarifyingQuestions.filter(Boolean)
                        if (questions.length > 0) {
                            contentText = 'To find the exact value, I need more specific details:\n' + questions.map((q) => `- ${q}`).join('\n')
                        }
                    } else if (structured.mode === 'value' && structured.mintValue) {
                        // Handle precise value responses
                        const mintValue = structured.mintValue
                        const denomination = structured.denomination || 'stamp'
                        const year = structured.year || ''
                        const color = structured.color || ''
                        const series = structured.series || ''

                        let valueResponse = `The mint value for the ${denomination}`
                        if (color) valueResponse += ` ${color}`
                        valueResponse += ' stamp'
                        if (year) valueResponse += ` from ${year}`
                        if (series) valueResponse += ` (${series} series)`
                        valueResponse += ` is $${mintValue} NZD.`

                        contentText = valueResponse
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
                    } else if (structured.mode === 'educational' && typeof structured.educationalText === 'string') {
                        contentText = structured.educationalText
                    }
                } else {
                    // If no structured response but the text contains value information, use it directly
                    // This handles cases where the AI provides direct value responses without JSON structure
                    if (response.output_text.includes('$') && response.output_text.includes('NZD')) {
                        contentText = response.output_text
                    }
                }

                const result = {
                    success: true,
                    responseId: response.id,
                    content: contentText,
                    source: 'voice_vector_search',
                    message: 'Voice search completed successfully!',
                    hasContext: !!previousResponseId,
                    structured,
                    mode: 'precise'
                }

                // Store the new response ID for future context
                activeSessions.set(sessionId, response.id)
                console.log('💾 Stored voice conversation context:', response.id)

                return result
            } catch (error) {
                // Clean up the request from active requests on error
                activeRequests.delete(messageKey)
                throw error
            }
        })()

        // Store the request promise for deduplication
        activeRequests.set(messageKey, requestPromise)

        // Wait for the request to complete
        const result = await requestPromise

        // Clean up the request from active requests
        activeRequests.delete(messageKey)

        return res.json(result)
    } catch (error) {
        // Clean up the request from active requests on error
        if (requestKey) {
            activeRequests.delete(requestKey)
        }

        console.error('❌ Error in Voice Vector Search API:', error)
        console.error('❌ Error details:', {
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined,
            name: error instanceof Error ? error.name : undefined,
            type: typeof error
        })

        // Provide more user-friendly error messages
        let userErrorMessage = 'I encountered an error while processing your voice request. Please try again.'

        if (error instanceof Error) {
            if (error.message.includes('timeout') || error.message.includes('TIMEOUT')) {
                userErrorMessage = 'The voice request took too long to process. Please try a more specific question about stamps.'
            } else if (error.message.includes('rate limit') || error.message.includes('RATE_LIMIT')) {
                userErrorMessage = 'Too many voice requests at once. Please wait a moment and try again.'
            } else if (error.message.includes('vector_store') || error.message.includes('file_search')) {
                userErrorMessage = 'There was an issue accessing the stamp database. Please try again or ask a different question.'
            }
        }

        return res.status(500).json({
            success: false,
            error: userErrorMessage,
            technicalError: error instanceof Error ? error.message : 'Unknown error'
        })
    }
}

// Optional: Add a GET endpoint to check session status
async function getVoiceVectorSearch(req, res) {
    const { searchParams } = new URL(req.url)
    const sessionId = searchParams.get('sessionId')

    if (sessionId) {
        const hasContext = activeSessions.has(sessionId)
        return res.json({
            sessionId,
            hasContext,
            previousResponseId: activeSessions.get(sessionId) || null
        })
    }

    return res.json({
        totalSessions: activeSessions.size,
        sessions: Array.from(activeSessions.keys())
    })
}

module.exports = {
    handleVoiceVectorSearchRequest,
    getVoiceVectorSearch
}