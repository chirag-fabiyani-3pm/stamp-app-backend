const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function handleVoiceStampSearchRequest(req, res) {
    try {
        const { query, sessionId } = req.body;

        if (!query) {
            return res.status(400).json({ error: 'Query is required' });
        }

        console.log('🔍 Voice stamp search query:', query);

        const searchResponse = await openai.beta.assistants.files.search(
            'vs_687f86f65d84819182d812c5184813a5', // Your vector store ID
            {
                query: query,
                max_results: 5
            }
        );

        console.log('🔍 Found stamps:', searchResponse.data.length);

        const stamps = searchResponse.data.map((item) => {
            const content = item.content?.[0]?.text?.value || '';

            try {
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const stampData = JSON.parse(jsonMatch[0]);
                    return {
                        id: stampData.id || item.id,
                        title: stampData.title || stampData.name || 'Unknown Stamp',
                        description: stampData.description || content.substring(0, 200),
                        country: stampData.country || 'Unknown',
                        year: stampData.year || 'Unknown',
                        denomination: stampData.denomination || 'Unknown',
                        imageUrl: stampData.imageUrl || stampData.stampImageUrl || null,
                        content: content
                    };
                }
            } catch (e) {
            }

            return {
                id: item.id,
                title: 'Stamp Found',
                description: content.substring(0, 200),
                country: 'Unknown',
                year: 'Unknown',
                denomination: 'Unknown',
                imageUrl: null,
                content: content
            };
        });

        return res.json({
            success: true,
            stamps: stamps,
            query: query,
            totalFound: stamps.length
        });

    } catch (error) {
        console.error('❌ Voice stamp search failed:', error);

        return res.json({
            success: false,
            stamps: [],
            query: req.body?.query || 'Unknown',
            totalFound: 0,
            error: 'Search failed, but I can still help with general stamp knowledge',
            fallback: true
        });
    }
}

module.exports = {
    handleVoiceStampSearchRequest,
};
