# Market Research Agent

This project is a market research agent that uses Playwright to browse forums and Reddit, scrapes user posts, and analyzes them using OpenAI's GPT model to suggest potential product ideas.

<video src="./recording.mov" controls preload></video>

## Prerequisites

1. **Node.js**: Install [Node.js](https://nodejs.org/) (v16 or higher recommended).
2. **OpenAI API Key**: Obtain an API key from [OpenAI](https://platform.openai.com/).
3. **Dependencies**: Install the required npm packages.

## Setup

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd scrouge
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up your OpenAI API key as an environment variable:
   ```bash
   export OPENAI_API_KEY=your_openai_api_key
   ```

## Running the Agent

1. Start the agent:
   ```bash
   node dist/agent.js
   ```

2. Enter the URLs you want to analyze when prompted. Separate multiple URLs with commas:
   ```
   Enter URLs separated by commas: https://www.reddit.com/r/someSubreddit/, https://www.someforum.com/someThread
   ```

3. The agent will browse the provided URLs, scrape posts, analyze them, and save insights into `insights.json`.

## Output

- Insights are saved in `insights.json` in the project directory. Each insight includes the suggested product idea and a timestamp.

## Notes

- Ensure the `.post` selector in `agent.ts` matches the structure of the websites you are scraping.
- Modify the `analyzePost` function in `nlp.ts` if you want to customize the analysis logic.

## Troubleshooting

- If you encounter issues with Playwright, ensure the required browser binaries are installed:
  ```bash
  npx playwright install
  ```

- If the OpenAI API key is not set, the agent will fail to analyze posts. Double-check your environment variable setup.
