const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function handleRealtimeSessionRequest(req, res) {
  try {
    const { voice = 'alloy', instructions } = req.body;
    
    console.log('🎤 Creating Realtime session with voice:', voice);
    
    const session = await openai.beta.realtime.sessions.create({
      model: 'gpt-4o-realtime-preview',
      voice: voice,
      instructions: instructions || `You are a knowledgeable stamp collecting expert. Answer questions about stamps, their history, and collecting. Keep responses concise and helpful. You can search for stamps using the available functions.`
    });
    
    console.log('🎤 Realtime session created:', session.id);
    
    return res.json({
      success: true,
      sessionId: session.id,
      client_secret: session.client_secret
    });
    
  } catch (error) {
    console.error('❌ Failed to create Realtime session:', error);
    return res.status(500).json({
      error: 'Failed to create Realtime session',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

module.exports = {
  handleRealtimeSessionRequest,
};
