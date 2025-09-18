const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function handleRealtimeSessionRequest(req, res) {
  try {
    const { voice = 'alloy', instructions, disable_ai_responses = false } = await request.json()

    console.log('🎤 Creating OpenAI Realtime session:', {
      voice,
      disable_ai_responses,
      instructions: instructions ? instructions.substring(0, 100) + '...' : 'Default instructions'
    });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: 'OpenAI API key not configured'
      });
    }

    // Create a Realtime session with the correct model name
    // Based on working examples, we use the specific model version
    const sessionConfig = {
      model: 'gpt-4o-realtime-preview-2025-06-03', // Latest stable version
      voice: voice,
      instructions: instructions || `You are a knowledgeable stamp collecting expert and navigation assistant.

CRITICAL: Always respond in the SAME LANGUAGE the user speaks. Detect the user's spoken language from their audio and match it exactly. If the language is unclear, respond in English by default.

You help with:
1. Stamp collecting (philatelly) questions, history, and values
2. App navigation and features
3. General philatelic knowledge

Keep responses concise, helpful, and always in the user's language. Respond naturally to user voice input.

IMPORTANT: This is a continuous conversation session. Users can interrupt you at any time by speaking, and you should stop and listen to them.`,
      tools: instructions?.includes('search_stamp_database') ? [
        {
          type: 'function',
          name: 'search_stamp_database',
          description: 'Search the comprehensive stamp database for specific stamp information, values, history, and details',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query for stamp information (e.g., "one day bright orange vermilion stamp", "US stamps from 1950s", "rare stamps from Germany")'
              }
            },
            required: ['query']
          }
        }
      ] : undefined
    };

    // If AI responses are disabled, configure the session accordingly
    if (disable_ai_responses) {
      console.log('🎤 Creating transcription-only session (AI responses disabled)')
      // Note: The actual disabling of AI responses is handled in the client-side session update
    }

    const session = await openai.beta.realtime.sessions.create(sessionConfig)

    console.log('🎤 Realtime session created successfully:', session);

    return res.json({
      ...session,
      client_secret: {
        value: session.client_secret?.value || session.client_secret
      }
    });
  } catch (error) {
    console.error('🎤 Error creating Realtime session:', error);
    return res.status(500).json({
      error: 'Failed to create Realtime session',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

module.exports = {
  handleRealtimeSessionRequest,
};
