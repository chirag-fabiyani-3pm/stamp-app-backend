
function createTimeoutPromise(ms) {
    return new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Request timeout')), ms);
    });
}

function generateStampCard(stamp) {
    const year = stamp.IssueYear || (stamp.IssueDate ? stamp.IssueDate.split('-')[0] : 'Unknown');
    const denomination = `${stamp.DenominationValue}${stamp.DenominationSymbol}`;
    const subtitle = `${stamp.Country} • ${year} • ${denomination}`;

    const imageUrl = stamp.StampImageUrl || stamp.image || stamp.StampImage || '/images/stamps/no-image-available.png';

    return {
        type: 'card',
        id: stamp.Id || stamp.id,
        title: stamp.stamp_core?.name || stamp.name || stamp.Name || stamp.catalogNumber || stamp.StampCatalogCode || 'Stamp',
        subtitle: subtitle,
        image: imageUrl,
        content: [
            {
                section: 'Overview',
                text: `${stamp.stamp_core?.name || stamp.name || stamp.Name} from ${stamp.country || stamp.Country}, issued in ${year}. Denomination: ${denomination}. Color: ${stamp.color || stamp.Color || 'Unknown'}.`
            },
            {
                section: 'Details',
                details: [
                    { label: 'Catalog Code', value: stamp.StampCatalogCode || 'N/A' },
                    { label: 'Issue Date', value: stamp.IssueDate || 'N/A' },
                    { label: 'Color', value: stamp.Color || 'N/A' },
                    { label: 'Paper Type', value: stamp.PaperType || 'N/A' },
                ],
            },
        ],
        significance: `A ${stamp.Color || 'colorful'} stamp from ${stamp.Country} issued in ${year}.`,
        specialNotes: stamp.SeriesName ? `Part of the ${stamp.SeriesName} series.` : '',
    };
}

function generateStampCarousel(stamps) {
    return {
        type: 'carousel',
        title: `Found ${stamps.length} stamp${stamps.length !== 1 ? 's' : ''}`,
        items: stamps.map(stamp => {
            const year = stamp.IssueYear || (stamp.IssueDate ? stamp.IssueDate.split('-')[0] : 'Unknown');
            const denomination = `${stamp.DenominationValue}${stamp.DenominationSymbol}`;
            const subtitle = `${stamp.country || stamp.Country} • ${year} • ${denomination}`

            // Handle different possible image URL field names
            const imageUrl = stamp.stampImageUrl || stamp.StampImageUrl || stamp.image || stamp.StampImage || '/images/stamps/no-image-available.png'

            return {
                id: stamp.Id || stamp.id,
                title: stamp.stamp_core?.name || stamp.name || stamp.Name || stamp.catalogNumber || stamp.StampCatalogCode || 'Stamp',
                subtitle,
                image: imageUrl,
                content: [
                    {
                        section: 'Overview',
                        text: `${stamp.stamp_core?.name || stamp.name || stamp.Name} from ${stamp.country || stamp.Country}, issued in ${year}. Denomination: ${denomination}. Color: ${stamp.color || stamp.Color || 'Unknown'}.`
                    },
                    {
                        section: 'Details',
                        details: [
                            { label: 'Catalog Code', value: stamp.catalogNumber || stamp.StampCatalogCode || 'N/A' },
                            { label: 'Issue Date', value: stamp.issueDate || stamp.IssueDate || 'N/A' },
                            { label: 'Color', value: stamp.color || stamp.Color || 'N/A' },
                            { label: 'Paper Type', value: stamp.paperType || stamp.PaperType || 'N/A' }
                        ]
                    }
                ],
                significance: `A ${stamp.color || stamp.Color || 'colorful'} stamp from ${stamp.country || stamp.Country} issued in ${year}.`,
                specialNotes: stamp.seriesName || stamp.SeriesName ? `Part of the ${stamp.seriesName || stamp.SeriesName} series.` : '',
                summary: `${denomination} ${stamp.color || stamp.Color || 'Unknown'}`,
                marketValue: 'Value varies by condition',
                quickFacts: [
                    `${stamp.country || stamp.Country} ${year}`,
                    stamp.color || stamp.Color || 'Unknown',
                    denomination,
                ],
            };
        }),
    };
}

function cleanResponseText(text) {
    let cleaned = text
        .replace(/download\.json/g, 'stamp database')
        .replace(/vector store/g, 'stamp collection')
        .replace(/file_search/g, 'search')
        .replace(/https:\/\/3pmplatformstorage\.blob\.core\.windows\.net\/[^ \\)\\]]+/g, '')
        .replace(/ref as [^ ]+/g, '')
        .replace(/catalog number [A-Z0-9]+/gi, '')
        .replace(/Campbell Paterson Catalogue/g, 'stamp catalog')
        .replace(/catalog number/g, 'catalog');

    cleaned = cleaned
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\{[\s\S]*?\}/g, '')
        .replace(/```[\s\S]*?```/g, '');

    cleaned = cleaned
        .replace(/technical details[^.]*\./g, '')
        .replace(/file reference[^.]*\./g, '')
        .replace(/database entry[^.]*\./g, '')
        .replace(/raw data[^.]*\./g, '')
        .replace(/function call[^.]*\./g, '');

    cleaned = cleaned
        .replace(/\s+/g, ' ')
        .replace(/\s+\./g, '.')
        .replace(/\s+,/g, ',')
        .replace(/\s+-/g, ' - ')
        .trim();

    return cleaned;
}

function parseResponse(response) {
    try {
        console.log('Parsing response:', response.substring(0, 200) + '...');

        const jsonMatch = response.match(/```json\\s*(\\{[\\s\\S]*?\\})\\s*```/);
        if (jsonMatch) {
            console.log('Found JSON block in response');
            const jsonData = JSON.parse(jsonMatch[1]);

            if (jsonData.stamps && Array.isArray(jsonData.stamps)) {
                console.log('Successfully parsed stamps from JSON block');
                return {
                    stamps: jsonData.stamps,
                    structuredData: jsonData,
                };
            }
        }

        const jsonMatch2 = response.match(/\\{[\\s\\S]*\\}/);
        if (jsonMatch2) {
            console.log('Found JSON in response (no code blocks)');
            const jsonData = JSON.parse(jsonMatch2[0]);

            if (jsonData.stamps && Array.isArray(jsonData.stamps)) {
                console.log('Successfully parsed stamps from JSON');
                return {
                    stamps: jsonData.stamps,
                    structuredData: jsonData,
                };
            }
        }

        if (response.includes('3pmplatformstorage.blob.core.windows.net')) {
            console.log('Response contains real image URLs but no JSON structure');
            const stampInfo = extractStampInfoFromText(response);
            if (stampInfo) {
                return {
                    stamps: [stampInfo],
                    structuredData: { stamps: [stampInfo] },
                };
            }
        }

        const extractedStamps = extractStampsFromConversation(response);
        if (extractedStamps.length > 0) {
            console.log('Successfully extracted stamps from conversational response');
            return {
                stamps: extractedStamps,
                structuredData: { stamps: extractedStamps },
            };
        }

        console.log('No valid JSON or stamp data found in response');
        return { stamps: [] };
    } catch (error) {
        console.log('❌ Failed to parse response:', error);
        return { stamps: [] };
    }
}

function extractStampsFromConversation(text) {
    const stamps = [];

    const stampPatterns = [
        /"([^"]+)"\\s+stamp\\s+from\\s+([^,]+)/gi,
        /([^"``]+)\\s+stamp\\s+from\\s+([^,]+)/gi,
        /([^"``]+)\\s+from\\s+([^,]+)/gi,
    ];

    for (const pattern of stampPatterns) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
            const stampName = match[1]?.trim();
            const country = match[2]?.trim();

            if (stampName && country) {
                const yearMatch = text.match(/(\\d{4})/);
                const year = yearMatch ? yearMatch[1] : 'Unknown';

                const denominationMatch = text.match(/(\\d+[\\/\\d]*\\s*[a-z]+)/i);
                const denomination = denominationMatch ? denominationMatch[1] : 'Unknown';

                const colorMatch = text.match(/(blue|red|green|yellow|brown|grey|gray|black|white|orange|purple|pink)/i);
                const color = colorMatch ? colorMatch[1] : 'Unknown';

                const imageUrlMatch = text.match(/https:\/\/3pmplatformstorage\.blob\.core\.windows\.net\/[^ \\)\\]]+/);
                const imageUrl = imageUrlMatch ? imageUrlMatch[0] : '/images/stamps/no-image-available.png';

                stamps.push({
                    Id: `extracted-${Date.now()}-${stamps.length}`,
                    Name: stampName,
                    Country: country,
                    IssueYear: year,
                    DenominationValue: denomination.includes('/') ? 1 : parseFloat(denomination.match(/\\d+/)?.[0] || '1'),
                    DenominationSymbol: denomination.includes('d') ? 'd' : denomination.includes('c') ? 'c' : '',
                    StampImageUrl: imageUrl,
                    Color: color,
                    SeriesName: 'Extracted from response',
                    IssueDate: year !== 'Unknown' ? `${year}-01-01` : null,
                    PaperType: 'Unknown',
                    CatalogNumber: 'N/A',
                });
            }
        }
    }

    return stamps;
}

function extractStampInfoFromText(text) {
    try {
        const imageUrlMatch = text.match(/https:\/\/3pmplatformstorage\.blob\.core\.windows\.net\/[^ \\)\\]]+/);
        if (imageUrlMatch) {
            const imageUrl = imageUrlMatch[0];

            const nameMatch = text.match(/\*\*([^*]+)\*\*/);
            const countryMatch = text.match(/Country[: ]+([^\\n]+)/i);
            const yearMatch = text.match(/Year[: ]+([^\\n]+)/i) || text.match(/(\\d{4})/);
            const denominationMatch = text.match(/Denomination[: ]+([^\\n]+)/i);

            return {
                id: `extracted-${Date.now()}`,
                name: nameMatch ? nameMatch[1].trim() : 'Stamp',
                country: countryMatch ? countryMatch[1].trim() : 'Unknown',
                year: yearMatch ? yearMatch[1].trim() : 'Unknown',
                denomination: denominationMatch ? denominationMatch[1].trim() : 'Unknown',
                image: imageUrl,
                description: text.substring(0, 200) + '...',
                marketValue: 'Unknown',
                rarity: 'Unknown',
            };
        }

        return null;
    } catch (error) {
        console.log('Failed to extract stamp info from text:', error);
        return null;
    }
}

module.exports = {
    createTimeoutPromise,
    generateStampCard,
    generateStampCarousel,
    cleanResponseText,
    parseResponse,
    extractStampsFromConversation,
    extractStampInfoFromText,
};
