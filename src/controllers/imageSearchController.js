
const multer = require('multer');
const { createTimeoutPromise } = require('../utils/helpers');
const { analyzeStampImage, findSimilarStamps } = require('../utils/imageProcessing');
const { TIMEOUT_MS } = require('../utils/openai');

const upload = multer();

async function handleImageSearchRequest(req, res) {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided' });
        }

        const imageFile = req.file;

        if (!imageFile.mimetype.startsWith('image/')) {
            return res.status(400).json({ error: 'Invalid file type. Please upload an image.' });
        }

        if (imageFile.size > 5 * 1024 * 1024) {
            return res.status(400).json({ error: 'File size too large. Please upload an image smaller than 5MB.' });
        }

        console.log('🔍 Processing image search...');
        console.log('📁 File:', imageFile.originalname, 'Size:', imageFile.size, 'Type:', imageFile.mimetype);

        const base64Image = imageFile.buffer.toString('base64');

        try {
            const timeoutPromise = createTimeoutPromise(TIMEOUT_MS);

            const imageProcessingPromise = (async () => {
                const stampAnalysis = await analyzeStampImage(base64Image);

                if (!stampAnalysis.isStamp) {
                    return {
                        isStamp: false,
                        confidence: stampAnalysis.confidence,
                        message: 'This image does not appear to be a stamp.',
                    };
                }

                const similarStamps = await findSimilarStamps(stampAnalysis.description);

                const bestMatch = similarStamps.length > 0 ? similarStamps[0] : null;

                return {
                    isStamp: true,
                    confidence: stampAnalysis.confidence,
                    stampDetails: bestMatch ? {
                        name: bestMatch.Name,
                        country: bestMatch.Country,
                        denomination: `${bestMatch.DenominationValue}${bestMatch.DenominationSymbol || ''}`,
                        year: bestMatch.IssueYear || 'Unknown',
                        color: bestMatch.Color || 'Unknown',
                        description: bestMatch.visualDescription || 'No description available',
                        imageUrl: bestMatch.StampImageUrl || '/images/stamps/no-image-available.png',
                    } : null,
                    suggestions: similarStamps.slice(0, 4).map(stamp => ({
                        name: stamp.Name,
                        country: stamp.Country,
                        similarity: stamp.similarity || 0.8,
                        imageUrl: stamp.StampImageUrl || '/images/stamps/no-image-available.png',
                    })),
                };
            })();

            const result = await Promise.race([imageProcessingPromise, timeoutPromise]);

            return res.json(result);

        } catch (error) {
            console.error('❌ Error in image processing:', error);

            if (error instanceof Error && error.message === 'Request timeout') {
                return res.status(408).json({
                    error: 'Image processing timed out. Please try again with a simpler image.',
                });
            }

            return res.status(500).json({
                error: 'Failed to process image. Please try again.',
            });
        }

    } catch (error) {
        console.error('❌ Error in image search:', error);
        return res.status(500).json({
            error: 'Failed to process image. Please try again.',
        });
    }
}

module.exports = {
    upload,
    handleImageSearchRequest,
};
