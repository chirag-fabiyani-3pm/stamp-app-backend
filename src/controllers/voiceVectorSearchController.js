const OpenAI = require('openai')

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

const VECTOR_STORE_ID = 'vs_68a700c721648191a8f8bd76ddfcd860'

// Session management for context - maps sessionId to previousResponseId and stamp context
const activeSessions = new Map()
const sessionStampContext = new Map()

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

        // Get previous stamp context for this session
        const previousStamps = sessionStampContext.get(sessionId) || []
        const recentStamps = previousStamps.filter(stamp => Date.now() - stamp.timestamp < 600000) // 10 minutes

        console.log('🎤 Voice vector search request:', {
            transcript: transcript.substring(0, 100) + (transcript.length > 100 ? '...' : ''),
            sessionId,
            mode,
            hasPreviousContext: activeSessions.has(sessionId),
            recentStampsCount: recentStamps.length
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

        // Clean up old session contexts (older than 10 minutes)
        for (const [sessionId, stamps] of sessionStampContext.entries()) {
            const recentStamps = stamps.filter(stamp => now - stamp.timestamp < 600000) // 10 minutes
            if (recentStamps.length === 0) {
                sessionStampContext.delete(sessionId)
                activeSessions.delete(sessionId)
                console.log('🧹 Cleaned up old session context:', sessionId)
            } else if (recentStamps.length !== stamps.length) {
                sessionStampContext.set(sessionId, recentStamps)
                console.log('🧹 Cleaned up old stamps from session:', sessionId)
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

                // Build context-aware instructions for Assistants API
                const contextInfo = recentStamps.length > 0 ? `
PREVIOUS STAMP CONTEXT (from recent searches):
${recentStamps.map((stamp, i) => `${i + 1}. ID: ${stamp.id}, Name: ${stamp.stampName}, Country: ${stamp.country}, Year: ${stamp.year}, Denomination: ${stamp.denomination}, Color: ${stamp.color}, Series: ${stamp.series}`).join('\n')}

CONTEXT RULES:
- When user says "compare it with...", "compare them", "compare both" → Use stamps from context + current search
- When user says "compare [stamp1] and [stamp2]" → Find both stamps mentioned
- When user says "compare [stamp] with [context_stamp]" → Use context stamp + search for new stamp
- Always return at least 2 stamp IDs for comparison mode
` : ''

                // Create response with vector store access and voice-optimized instructions
                const response = await openai.responses.create({
                    model: 'gpt-4o',
                    input: transcript,
                    temperature: 0,
                    max_output_tokens: 300,
                    instructions: `You are PhilaGuide AI, a stamp expert providing precise responses from the Campbell Peterson catalog.

CRITICAL RULES - FOLLOW EXACTLY:
1. If user asks to "show", "display", "see", or "view" a stamp → Return ONLY raw JSON with mode: "cards" (NO markdown, NO text, NO lists, NO explanations)
2. If user asks to "compare" stamps → Return ONLY raw JSON with mode: "comparison" with MULTIPLE stamp IDs (NO markdown, NO text, NO lists, NO explanations)
3. If user asks for "value", "worth", or "price" → Return ONLY short text with exact mintValue
4. Keep ALL responses under 2 sentences maximum

${contextInfo}

SHOW REQUESTS - Return ONLY this exact JSON format (nothing else):
{
  "mode": "cards",
  "cards": [{"id": "[stampId]", "stampName": "[name]", "country": "[country]", "year": "[year]", "denomination": "[denom]", "color": "[color]", "series": "[series]", "catalogNumber": "[cat#]", "imageUrl": "[url]", "description": "[desc]", "mintValue": "[value]", "finestUsedValue": "[usedValue]"}]
}

COMPARISON REQUESTS - Return ONLY this exact JSON format (nothing else):
- When user says "compare", "compare both", "show comparison" → ALWAYS return comparison mode
- MUST find ALL stamps mentioned in the comparison request
- MUST return at least 2 stamp IDs, up to 3 maximum
- Example: "compare 1d orange and 1d red" → find BOTH stamps and return their IDs
- NEVER return cards mode for comparison requests
{
  "mode": "comparison",
  "stampIds": ["[stampId1]", "[stampId2]", "[stampId3]"]
}

VALUE REQUESTS - Return ONLY this text:
"The [denomination] [color] stamp from [year] is worth $[mintValue] NZD."

CLARIFICATION - Return ONLY this JSON:
{
  "mode": "clarify",
  "clarifyingQuestions": ["What denomination?", "What year or series?"]
}

NEVER return markdown lists, numbered lists, or explanatory text for show requests. ONLY return the JSON structure above.

Search the vector store for exact matches. Use exact data only.`,
                    tools: [
                        { type: 'file_search', vector_store_ids: [VECTOR_STORE_ID] }
                    ],
                    // Add conversation context if available
                    ...(previousResponseId && { previous_response_id: previousResponseId })
                })

                console.log('🔍 Voice search response received:', {
                    responseId: response.id,
                    status: response.status,
                    outputType: response.output?.[0]?.type,
                    outputText: response.output_text?.substring(0, 200) + '...'
                })

                // Build normalized content text and structured field
                let structured = null
                let contentText = response.output_text

                console.log('🔍 Raw AI response:', response.output_text)

                // Try to extract JSON from markdown code blocks first
                let possibleJson = ''
                const markdownJsonMatch = response.output_text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
                if (markdownJsonMatch) {
                    possibleJson = markdownJsonMatch[1]
                    console.log('🔍 Extracted JSON from markdown:', possibleJson)
                } else {
                    // Fallback to original method - look for JSON objects
                    const jsonStart = response.output_text.indexOf('{')
                    if (jsonStart !== -1) {
                        // Find the end of the JSON more carefully
                        let braceCount = 0
                        let jsonEnd = jsonStart
                        let inString = false
                        let escapeNext = false

                        for (let i = jsonStart; i < response.output_text.length; i++) {
                            const char = response.output_text[i]

                            if (escapeNext) {
                                escapeNext = false
                                continue
                            }

                            if (char === '\\') {
                                escapeNext = true
                                continue
                            }

                            if (char === '"' && !escapeNext) {
                                inString = !inString
                                continue
                            }

                            if (!inString) {
                                if (char === '{') {
                                    braceCount++
                                } else if (char === '}') {
                                    braceCount--
                                    if (braceCount === 0) {
                                        jsonEnd = i
                                        break
                                    }
                                }
                            }
                        }

                        if (braceCount === 0 && jsonEnd > jsonStart) {
                            possibleJson = response.output_text.slice(jsonStart, jsonEnd + 1)
                            console.log('🔍 Extracted JSON from plain text:', possibleJson)
                        } else {
                            console.log('❌ Incomplete JSON detected, brace count:', braceCount)
                        }
                    }
                }

                if (possibleJson) {
                    try {
                        const parsed = JSON.parse(possibleJson)
                        if (parsed && typeof parsed === 'object' && parsed.mode) {
                            structured = parsed
                            console.log('✅ Successfully parsed structured data:', structured)
                        }
                    } catch (e) {
                        console.log('❌ JSON parsing failed:', e)
                        // Try to fix incomplete JSON by adding missing closing brackets
                        if (possibleJson.includes('"mode": "cards"') && possibleJson.includes('"cards": [')) {
                            let fixedJson = possibleJson
                            // Count missing closing brackets
                            const openBraces = (fixedJson.match(/\{/g) || []).length
                            const closeBraces = (fixedJson.match(/\}/g) || []).length
                            const openBrackets = (fixedJson.match(/\[/g) || []).length
                            const closeBrackets = (fixedJson.match(/\]/g) || []).length

                            // Add missing closing brackets
                            for (let i = 0; i < (openBrackets - closeBrackets); i++) {
                                fixedJson += ']'
                            }
                            for (let i = 0; i < (openBraces - closeBraces); i++) {
                                fixedJson += '}'
                            }

                            console.log('🔧 Attempting to fix JSON:', fixedJson)
                            try {
                                const fixedParsed = JSON.parse(fixedJson)
                                if (fixedParsed && typeof fixedParsed === 'object' && fixedParsed.mode) {
                                    structured = fixedParsed
                                    console.log('✅ Successfully parsed fixed structured data:', structured)
                                }
                            } catch (fixError) {
                                console.log('❌ Fixed JSON parsing also failed:', fixError)
                            }
                        }
                    }
                } else {
                    console.log('❌ No JSON found in response, using raw text')

                    // Fallback: Try to extract stamp data from text response for show requests
                    if (response.output_text.toLowerCase().includes('show') ||
                        response.output_text.toLowerCase().includes('display') ||
                        response.output_text.toLowerCase().includes('see') ||
                        response.output_text.toLowerCase().includes('view')) {

                        console.log('🔧 Attempting to extract stamp data from text response')

                        // Try to extract stamp information from the text
                        const stampMatch = response.output_text.match(/\*\*([^*]+)\*\*/)
                        const countryMatch = response.output_text.match(/Country:\s*([^\n]+)/i)
                        const yearMatch = response.output_text.match(/Year:\s*([^\n]+)/i)
                        const denominationMatch = response.output_text.match(/Denomination:\s*([^\n]+)/i)
                        const colorMatch = response.output_text.match(/Color:\s*([^\n]+)/i)
                        const seriesMatch = response.output_text.match(/Series:\s*([^\n]+)/i)
                        const imageMatch = response.output_text.match(/\[Link\]\(([^)]+)\)/)

                        if (stampMatch && countryMatch && yearMatch) {
                            // Generate a simple ID based on the stamp name
                            const stampId = `extracted-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

                            structured = {
                                mode: "cards",
                                cards: [{
                                    id: stampId,
                                    stampName: stampMatch[1].trim(),
                                    country: countryMatch[1].trim(),
                                    year: yearMatch[1].trim(),
                                    denomination: denominationMatch?.[1]?.trim() || 'Unknown',
                                    color: colorMatch?.[1]?.trim() || 'Unknown',
                                    series: seriesMatch?.[1]?.trim() || 'Unknown',
                                    catalogNumber: 'Unknown',
                                    imageUrl: imageMatch?.[1]?.trim() || '/images/stamps/no-image-available.png',
                                    description: `Extracted from text: ${stampMatch[1].trim()}`,
                                    mintValue: '0',
                                    finestUsedValue: '0'
                                }]
                            }

                            console.log('✅ Successfully extracted structured data from text:', structured)
                        }
                    }

                    // Fallback: Try to extract comparison data from text response for compare requests
                    if (response.output_text.toLowerCase().includes('compare') ||
                        response.output_text.toLowerCase().includes('comparison') ||
                        transcript.toLowerCase().includes('compare')) {

                        console.log('🔧 Attempting to extract comparison data from text response')
                        console.log('🔧 Original transcript:', transcript)
                        console.log('🔧 Recent stamps context:', recentStamps)

                        // Try to extract stamp IDs from the text response
                        const stampIdMatches = response.output_text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi)

                        console.log('🔧 Found stamp ID matches:', stampIdMatches)

                        if (stampIdMatches && stampIdMatches.length >= 2) {
                            structured = {
                                mode: "comparison",
                                stampIds: stampIdMatches.slice(0, 3) // Limit to 3 stamps
                            }

                            console.log('✅ Successfully extracted comparison data from text:', structured)
                        } else if (stampIdMatches && stampIdMatches.length === 1) {
                            console.log('⚠️ Only found 1 stamp ID for comparison, trying to use context')

                            // Try to use context stamps for comparison
                            if (recentStamps.length > 0) {
                                const contextStampIds = recentStamps.map(stamp => stamp.id)
                                const allStampIds = [...stampIdMatches, ...contextStampIds.filter(id => !stampIdMatches.includes(id))]

                                if (allStampIds.length >= 2) {
                                    structured = {
                                        mode: "comparison",
                                        stampIds: allStampIds.slice(0, 3)
                                    }
                                    console.log('✅ Using context stamps for comparison:', structured)
                                } else {
                                    // Force comparison mode even with 1 stamp to trigger navigation
                                    structured = {
                                        mode: "comparison",
                                        stampIds: stampIdMatches
                                    }
                                    console.log('🔧 Forcing comparison mode with single stamp:', structured)
                                }
                            } else {
                                // Force comparison mode even with 1 stamp to trigger navigation
                                structured = {
                                    mode: "comparison",
                                    stampIds: stampIdMatches
                                }
                                console.log('🔧 Forcing comparison mode with single stamp:', structured)
                            }
                        } else {
                            // No stamp IDs found in response, try to use context stamps
                            console.log('❌ No stamp IDs found in comparison response, trying context')

                            if (recentStamps.length >= 2) {
                                const contextStampIds = recentStamps.map(stamp => stamp.id)
                                structured = {
                                    mode: "comparison",
                                    stampIds: contextStampIds.slice(0, 3)
                                }
                                console.log('✅ Using context stamps for comparison:', structured)
                            } else if (recentStamps.length === 1) {
                                // Only one context stamp, need to search for another
                                console.log('⚠️ Only 1 context stamp available, need to search for another')
                                structured = {
                                    mode: "clarify",
                                    clarifyingQuestions: ["Which other stamp would you like to compare with?"]
                                }
                                console.log('🔧 Requesting clarification for comparison:', structured)
                            } else {
                                console.log('❌ No stamp IDs found and no context available')
                                console.log('❌ Response text:', response.output_text.substring(0, 500))
                            }
                        }
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
                        // Store stamp context for future comparison requests
                        structured.cards.forEach((card) => {
                            if (card.id && card.stampName) {
                                const stampContext = {
                                    id: card.id,
                                    stampName: card.stampName,
                                    country: card.country || '',
                                    year: card.year || '',
                                    denomination: card.denomination || '',
                                    color: card.color || '',
                                    series: card.series || '',
                                    timestamp: Date.now()
                                }

                                const currentContext = sessionStampContext.get(sessionId) || []
                                // Remove duplicates and add new stamp
                                const filteredContext = currentContext.filter(stamp => stamp.id !== card.id)
                                filteredContext.push(stampContext)

                                // Keep only last 5 stamps to avoid context bloat
                                sessionStampContext.set(sessionId, filteredContext.slice(-5))
                                console.log('💾 Stored stamp context for session:', sessionId, stampContext)
                            }
                        })

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

                console.log('🔍 Final result being returned:', {
                    success: result.success,
                    structured: result.structured,
                    contentLength: result.content?.length,
                    hasComparison: result.structured?.mode === 'comparison'
                })

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