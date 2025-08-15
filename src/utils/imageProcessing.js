
const fs = require('fs');
const { openai } = require('./openai');

async function analyzeStampImage(base64Image) {
    try {
        console.log('🔍 Analyzing image with OpenAI Vision...');

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Analyze this image and determine if it's a postage stamp. Provide a detailed description of what you see.\n\nRequirements:\n1. Determine if this is a postage stamp (not a coin, banknote, or other item)\n2. If it IS a stamp, provide a detailed description including:\n   - Country name\n   - Denomination/value\n   - Colors used\n   - Main subject/theme (portrait, animal, building, etc.)\n   - Text elements visible\n   - Any distinctive features\n   - Approximate year/era if visible\n\n3. If it's NOT a stamp, explain why not\n\n4. Provide a confidence score (0-1) for your assessment\n\n5. Format your response as JSON:\n{\n  \"isStamp\": true/false,\n  \"confidence\": 0.95,\n  \"description\": \"Detailed description of the stamp...\",\n  \"country\": \"Country name if visible\",\n  \"denomination\": \"Value/denomination if visible\",\n  \"colors\": [\"color1\", \"color2\"],\n  \"subject\": \"Main subject/theme\",\n  \"year\": \"Approximate year if visible\"\n}`,
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Image}`,
                            },
                        },
                    ],
                },
            ],
            max_tokens: 1000,
        });

        const analysisText = response.choices[0]?.message?.content;
        console.log('📊 Analysis result:', analysisText);

        if (!analysisText) {
            throw new Error('No analysis result received');
        }

        try {
            const analysis = JSON.parse(analysisText);
            return {
                isStamp: analysis.isStamp || false,
                confidence: analysis.confidence || 0.5,
                description: analysis.description || '',
                country: analysis.country || '',
                denomination: analysis.denomination || '',
                colors: analysis.colors || [],
                subject: analysis.subject || '',
                year: analysis.year || '',
            };
        } catch (parseError) {
            console.log('⚠️ Could not parse JSON response, using text analysis');

            const text = analysisText.toLowerCase();
            const isStamp = text.includes('stamp') || text.includes('postage');
            const confidence = isStamp ? 0.7 : 0.3;

            return {
                isStamp,
                confidence,
                description: analysisText,
                country: '',
                denomination: '',
                colors: [],
                subject: '',
                year: '',
            };
        }

    } catch (error) {
        console.error('❌ Error analyzing image:', error);
        return {
            isStamp: false,
            confidence: 0.1,
            description: 'Unable to analyze image',
            country: '',
            denomination: '',
            colors: [],
            subject: '',
            year: '',
        };
    }
}

async function findSimilarStamps(description) {
    try {
        console.log('🔍 Finding similar stamps...');

        const stampsFile = './stamps-with-descriptions.json';

        if (!fs.existsSync(stampsFile)) {
            console.log('⚠️ No enhanced stamps file found, using basic search');
            return [];
        }

        const stamps = JSON.parse(fs.readFileSync(stampsFile, 'utf8'));
        console.log(`📊 Searching through ${stamps.length} stamps`);

        const searchTerms = description.toLowerCase().split(' ');
        const results = stamps
            .filter(stamp => {
                if (!stamp.visualDescription) return false;

                const stampText = `${stamp.Name} ${stamp.Country} ${stamp.Color || ''} ${stamp.visualDescription}`.toLowerCase();

                const matches = searchTerms.filter(term =>
                    stampText.includes(term) && term.length > 2,
                ).length;

                return matches > 0;
            })
            .map(stamp => {
                const stampText = `${stamp.Name} ${stamp.Country} ${stamp.Color || ''} ${stamp.visualDescription}`.toLowerCase();
                const matches = searchTerms.filter(term =>
                    stampText.includes(term) && term.length > 2,
                ).length;

                return {
                    ...stamp,
                    similarity: Math.min(matches / searchTerms.length, 1),
                };
            })
            .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
            .slice(0, 5);

        console.log(`✅ Found ${results.length} similar stamps`);
        return results;

    } catch (error) {
        console.error('❌ Error finding similar stamps:', error);
        return [];
    }
}

module.exports = {
    analyzeStampImage,
    findSimilarStamps,
};
