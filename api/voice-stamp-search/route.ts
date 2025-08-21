import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(request: NextRequest) {
    try {
        const { query, sessionId } = await request.json()

        if (!query) {
            return NextResponse.json({ error: 'Query is required' }, { status: 400 })
        }

        console.log('🔍 Voice stamp search query:', query)

        // Search the vector store for stamps
        const searchResponse = await openai.beta.assistants.files.search(
            'vs_68a700c721648191a8f8bd76ddfcd860', // Your vector store ID
            {
                query: query,
                max_results: 5
            }
        )

        console.log('🔍 Found stamps:', searchResponse.data.length)

        // Process the search results
        const stamps = searchResponse.data.map((item: any) => {
            // Extract stamp information from the search result
            const content = item.content?.[0]?.text?.value || ''

            // Try to parse stamp data from the content
            try {
                // Look for JSON-like content in the text
                const jsonMatch = content.match(/\{[\s\S]*\}/)
                if (jsonMatch) {
                    const stampData = JSON.parse(jsonMatch[0])
                    return {
                        id: stampData.id || item.id,
                        title: stampData.title || stampData.name || 'Unknown Stamp',
                        description: stampData.description || content.substring(0, 200),
                        country: stampData.country || 'Unknown',
                        year: stampData.year || 'Unknown',
                        denomination: stampData.denomination || 'Unknown',
                        imageUrl: stampData.imageUrl || stampData.stampImageUrl || null,
                        content: content
                    }
                }
            } catch (e) {
                // If JSON parsing fails, return basic info
            }

            // Fallback to basic content extraction
            return {
                id: item.id,
                title: 'Stamp Found',
                description: content.substring(0, 200),
                country: 'Unknown',
                year: 'Unknown',
                denomination: 'Unknown',
                imageUrl: null,
                content: content
            }
        })

        return NextResponse.json({
            success: true,
            stamps: stamps,
            query: query,
            totalFound: stamps.length
        })

    } catch (error) {
        console.error('❌ Voice stamp search failed:', error)

        // Return a fallback response
        return NextResponse.json({
            success: false,
            stamps: [],
            query: request.body?.query || 'Unknown',
            totalFound: 0,
            error: 'Search failed, but I can still help with general stamp knowledge',
            fallback: true
        })
    }
}

