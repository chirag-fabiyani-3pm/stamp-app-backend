import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(request: NextRequest) {
  try {
    const { voice = 'alloy', instructions } = await request.json()
    
    console.log('🎤 Creating Realtime session with voice:', voice)
    
    // Create a Realtime session with OpenAI
    const session = await openai.beta.realtime.sessions.create({
      model: 'gpt-4o-realtime-preview',
      voice: voice,
      instructions: instructions || `You are a knowledgeable stamp collecting expert. Answer questions about stamps, their history, and collecting. Keep responses concise and helpful. You can search for stamps using the available functions.`
    })
    
    console.log('🎤 Realtime session created:', session.id)
    
    return NextResponse.json({
      success: true,
      sessionId: session.id,
      client_secret: session.client_secret
    })
    
  } catch (error) {
    console.error('❌ Failed to create Realtime session:', error)
    return NextResponse.json({
      error: 'Failed to create Realtime session',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}

