import * as fs from 'fs';

const insightsFile = './insights.json';

export function saveInsight(insight: string) {
    const insights = fs.existsSync(insightsFile)
        ? JSON.parse(fs.readFileSync(insightsFile, 'utf-8'))
        : [];

    insights.push({ insight, timestamp: new Date().toISOString() });
    fs.writeFileSync(insightsFile, JSON.stringify(insights, null, 2));
}
