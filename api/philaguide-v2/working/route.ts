import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

const VECTOR_STORE_ID = 'vs_68a700c721648191a8f8bd76ddfcd860'

// Session management for context - maps sessionId to previousResponseId
const activeSessions = new Map<string, string>()

// Request deduplication - prevent multiple identical requests
const activeRequests = new Map<string, Promise<any>>() // requestKey -> Promise

export async function POST(request: NextRequest) {
    let requestKey: string | undefined

    try {
        const { message, sessionId, isVoiceChat = false } = await request.json()

        // Basic input validation
        if (!message || typeof message !== 'string') {
            return NextResponse.json({
                success: false,
                error: 'Message is required and must be a string'
            }, { status: 400 })
        }

        if (message.length > 2000) {
            return NextResponse.json({
                success: false,
                error: 'Message is too long. Please keep your questions under 2000 characters.'
            }, { status: 400 })
        }

        if (!sessionId || typeof sessionId !== 'string') {
            return NextResponse.json({
                success: false,
                error: 'Session ID is required'
            }, { status: 400 })
        }

        console.log('🚀 Working Philaguide V2 API called with:', {
            message: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
            sessionId,
            isVoiceChat,
            hasPreviousContext: activeSessions.has(sessionId)
        })

        // Create request key for deduplication - use session and message content only
        const messageKey = `${sessionId}:${message.trim().toLowerCase()}`

        // Check if identical request is already in progress
        if (activeRequests.has(messageKey)) {
            console.log('🔄 Duplicate request detected, returning existing promise')
            return activeRequests.get(messageKey)!
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
                console.log('🧹 Cleaned up old request:', key)
            }
        }

        // Get previous response ID for conversation context
        const previousResponseId = activeSessions.get(sessionId)

        if (previousResponseId) {
            console.log('📚 Using conversation context from:', previousResponseId)
        } else {
            console.log('🆕 Starting new conversation session')
        }

        // Create the request promise and store it for deduplication
        const requestPromise = (async () => {
            try {
                // Create response with vector store access, context, and structured output
                const response = await openai.responses.create({
                    model: 'gpt-4o',
                    input: message,
                    instructions: `You are PhilaGuide AI, a specialized philatelic assistant with access to a comprehensive stamp database AND internet search capabilities.

🚨🚨🚨 SEARCH PRIORITY & FALLBACK STRATEGY 🚨🚨🚨

STEP 1: For stamp-related queries, ALWAYS search your knowledge base first using file_search
STEP 2: If NO relevant stamps found in knowledge base, IMMEDIATELY use web_search_preview to find information from the internet
STEP 3: Provide the best available information from either source

🤖 SIMPLE CONVERSATION RULE:
- If user message is just a greeting (single word like "Hi", "Hello", "Hey") WITHOUT any stamp context, respond conversationally
- For ALL other messages including questions about stamps, philatelic topics, or detailed queries, use the full search strategy above

🔍 KNOWLEDGE BASE SEARCH (Primary):
When you find stamps in your knowledge base, format using this EXACT structure:

## Stamp Information
**Stamp Name**: [Real 'name' field from knowledge base]
**Country**: [Real 'countryName' field from knowledge base]  
**ID**: [Real 'id' field from knowledge base - CRITICAL: Use 'id' NOT 'stampId' for UI compatibility]
**Image URL**: [Real 'stampImageUrl' from knowledge base OR extract actual Azure blob URL, never use placeholder]
**Description**: [Combine MULTIPLE description fields: 'description' + 'seriesDescription' + relevant others for comprehensive details]
**Series**: [Real 'seriesName' field if available]
**Year**: [Real 'issueYear' field if available]
**Denomination**: [Real 'denominationDisplay' field if available]
**Catalog Number**: [Real 'catalogNumber' field if available]
**Theme**: [Real 'theme' and 'subject' fields if available]
**Technical Details**: [Combine 'typeName' + 'perforationName' + 'paperTypeName' + 'colorName' if relevant]

🚨 CRITICAL DATA MAPPING RULES:
1. **ID Field**: ALWAYS use 'id' field (NOT 'stampId') - this is what the UI components expect
2. **Multiple Descriptions**: Search and combine these description fields for comprehensive results:
   - 'description' (primary)
   - 'seriesDescription' 
   - 'colorDescription'
   - 'stampGroupDescription'
   - 'issueContext'
3. **Search Strategy**: When user queries mention colors, series, techniques, or specific details, search across ALL relevant description fields
4. **Image URLs**: Extract actual blob storage URLs from 'stampImageUrl' or any other image fields, never use "Not provided"

🎯 VARIETY HANDLING RULES:
5. **Variety Queries**: When users ask about varieties, errors, or different versions of stamps:
   - **Primary Search**: Search for stamps with the SAME 'catalogNumber' (e.g., PC10a, PE22a)
   - **Enhanced Search**: ALSO search for stamps with the SAME 'parentStampId' for direct family relationships
   - **Dual Strategy**: Use both catalog number grouping AND parent-child relationships for comprehensive variety coverage
   - **Group Related Varieties**: Group all stamps with identical catalog numbers OR identical parentStampId as related varieties
   - **Use 'varieties_errors' documents**: For detailed variety information and variety-specific fields
   - **Include Variety Details**: varietyType, perforationVariety, colorVariety, paperVariety, knownError, majorVariety
   - **Show Relationship Info**: Indicate if stamps are parent stamps, child varieties, or related instances
   - **Variety Count**: Show total variety count and types when available

6. **Variety Response Format**: For variety queries, structure response as:
   ## Stamp Varieties
   **Main Stamp**: [Name] (Catalog #: [Number])
   **Parent Stamp ID**: [parentStampId if available]
   **Varieties Found**: [Count] varieties
   **Variety Types**: [List variety types found]
   **Relationship Type**: [Parent/Child/Related Instance]
   
   ### Variety Details:
   **Variety 1**: [Name] - [Variety Type] - [Specific Details] - [Parent/Child status]
   **Variety 2**: [Name] - [Variety Type] - [Specific Details] - [Parent/Child status]
   [Continue for all varieties...]
   
   ### Relationship Information:
   **Parent Stamp**: [Main stamp that other varieties are based on]
   **Child Varieties**: [List of stamps that are variations of the parent]
   **Related Instances**: [Stamps with same catalog number but different characteristics]

🌐 INTERNET SEARCH (Fallback):
When knowledge base has NO relevant results, use web_search_preview and format as:

## Stamp Information (from Internet Research)
Based on my internet research, here's what I found about the [stamp name]:

**Stamp Details:**
- **Name**: [Name from internet sources]
- **Country**: [Country from internet sources]
- **Year/Period**: [Issue date/period from internet sources]
- **Denomination**: [Value from internet sources]
- **Description**: [Description from internet sources]
- **Significance**: [Historical context or importance]

*Note: This information is from internet research as this specific stamp wasn't found in our specialized database.*

CRITICAL SEARCH PROCESS:
1. ALWAYS search vector store FIRST with file_search
2. If vector store returns NO relevant stamps or limited results, IMMEDIATELY use web_search_preview
3. NEVER say "I couldn't find details" without first trying BOTH searches
4. Be transparent about information source (knowledge base vs internet)
5. Provide the most comprehensive information available from either source

RESPONSE QUALITY RULES:
- Knowledge base data: Use EXACT structure with real Azure URLs and IDs
- Internet data: Provide detailed information with clear source attribution
- NEVER use placeholder data like "(image not available)" or "Not provided"
- ALWAYS attempt both search methods before saying information unavailable
- Be helpful, informative, and accurate about stamp collecting topics

PROPER MARKDOWN FORMATTING RULES:
Create clean, readable responses with proper markdown:

**CORRECT FORMAT EXAMPLE:**
## Stamp Information
**Trout Blue 1/3d**: A beautiful stamp from New Zealand issued on May 4, 1935. This stamp features a leaping trout design and is part of the 1935-1947 Pictorial Issue series.

**Key Information:**
- Country: New Zealand
- Issue Date: May 4, 1935
- Denomination: 1/3d
- Color: Blue
- Series: 1935-1947 Pictorial Issue

**WRONG FORMAT (NEVER USE):**
- Raw knowledge base output with dashes and labels
- Technical data or URLs in conversation
- Example data or placeholder information
- "(image not available)" or "Not provided" - extract the actual data

**REMEMBER:**
1. ALWAYS search vector store before responding
2. ONLY return REAL data from your knowledge base
3. Use the EXACT format above for stamp information
4. NEVER invent or make up stamp details
5. ALWAYS extract actual image URLs from the knowledge base`,
                    tools: [
                        { type: 'file_search', vector_store_ids: [VECTOR_STORE_ID] },
                        { type: 'web_search_preview' }
                    ],
                    // Add conversation context if available
                    ...(previousResponseId && { previous_response_id: previousResponseId })
                })

                // Detect source based on response content and tools used
                let detectedSource = 'knowledge_base'
                const responseContent = response.output_text.toLowerCase()

                // Check if internet research was mentioned in the response
                if (responseContent.includes('internet research') ||
                    responseContent.includes('based on my internet research') ||
                    responseContent.includes('from internet sources') ||
                    responseContent.includes('web search')) {
                    detectedSource = 'internet'
                } else if (responseContent.includes('knowledge base') ||
                    responseContent.includes('database')) {
                    detectedSource = 'knowledge_base'
                } else if (responseContent.includes('## stamp information') &&
                    !responseContent.includes('internet research')) {
                    detectedSource = 'knowledge_base'
                }

                console.log('🔍 Detected source:', detectedSource, 'based on content analysis')

                const result = {
                    success: true,
                    responseId: response.id,
                    content: response.output_text,
                    source: detectedSource,
                    message: 'Response generated successfully!',
                    hasContext: !!previousResponseId
                }

                // Store the new response ID for future context
                activeSessions.set(sessionId, response.id)
                console.log('💾 Stored conversation context:', response.id)

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

        return NextResponse.json(result)
    } catch (error) {
        // Clean up the request from active requests on error
        if (requestKey) {
            activeRequests.delete(requestKey)
        }

        console.error('❌ Error in Working Philaguide V2 API:', error)
        console.error('❌ Error details:', {
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined,
            name: error instanceof Error ? error.name : undefined,
            type: typeof error
        })

        // Provide more user-friendly error messages
        let userErrorMessage = 'I encountered an error while processing your request. Please try again.'

        if (error instanceof Error) {
            if (error.message.includes('timeout') || error.message.includes('TIMEOUT')) {
                userErrorMessage = 'The request took too long to process. Please try a more specific question about stamps.'
            } else if (error.message.includes('rate limit') || error.message.includes('RATE_LIMIT')) {
                userErrorMessage = 'Too many requests at once. Please wait a moment and try again.'
            } else if (error.message.includes('vector_store') || error.message.includes('file_search')) {
                userErrorMessage = 'There was an issue accessing the stamp database. Please try again or ask a different question.'
            }
        }

        return NextResponse.json({
            success: false,
            error: userErrorMessage,
            technicalError: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 })
    }
}

// Optional: Add a GET endpoint to check session status
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url)
    const sessionId = searchParams.get('sessionId')

    if (sessionId) {
        const hasContext = activeSessions.has(sessionId)
        return NextResponse.json({
            sessionId,
            hasContext,
            previousResponseId: activeSessions.get(sessionId) || null
        })
    }

    return NextResponse.json({
        totalSessions: activeSessions.size,
        sessions: Array.from(activeSessions.keys())
    })
}
