import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function analyzePost(text: string) {
	// ...basic guards...
	if (!text) return null;

	// Compose a compact prompt asking for JSON output
	const prompt = `Analyze the following social post and return a JSON object with keys:
- summary: short summary
- sentiment: "positive" | "neutral" | "negative"
- topics: array of short topic strings
- toxicityScore: number between 0 and 1

Post:
"""${text.replace(/"""|\\/g, match => (match === '"""' ? '\\"\"\"' : '\\\\'))}"""`;

	try {
		const resp = await client.responses.create({
			model: "gpt-5-mini",
			input: prompt,
			// limit tokens to keep responses compact; adjust as needed
			max_output_tokens: 300,
		});

		// ...robust extraction of textual output from response...
		let outputText = "";
		if (resp.output) {
			for (const o of resp.output) {
				// content can be string or array of content parts
				const c = (o as any).content;
				if (typeof c === "string") {
					outputText += c;
				} else if (Array.isArray(c)) {
					for (const part of c) {
						if (typeof part === "string") outputText += part;
						else if (part?.text) outputText += part.text;
					}
				} else if ((o as any).text) {
					outputText += (o as any).text;
				}
			}
		} else if ((resp as any).output_text) {
			outputText = (resp as any).output_text;
		}

		outputText = outputText.trim();

		// Try to parse JSON first (preferred)
		try {
			const parsed = JSON.parse(outputText);
			return parsed;
		} catch {
			// If the model didn't return strict JSON, attempt to extract JSON substring
			const jsonMatch = outputText.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				try {
					return JSON.parse(jsonMatch[0]);
				} catch {
					// fall through
				}
			}
			// Fallback: return best-effort structure
			return {
				summary: outputText,
				raw: outputText,
			};
		}
	} catch (err) {
		console.error("analyzePost error:", err);
		throw err;
	}
}
