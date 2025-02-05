import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { getMcpTools, initializeMcp, cleanupMcp } from '../src';

import dotenv from 'dotenv';
dotenv.config();

async function main() {
  try {
    // Initialize MCP
    await initializeMcp({ debug: true });

    // Test playwright server
    console.log('\nTesting Playwright server...');
    const playwrightTools = await getMcpTools({ serverName: 'playwright' });

    // Test browser navigation and screenshot
    const result = await generateText({
      model: google('gemini-1.5-flash'),
      messages: [
        {
          role: 'system',
          content:
            'You are a web automation assistant that uses Playwright to navigate websites and extract information. Use the provided tools in sequence: first navigate to the page, then interact with it as needed.',
        },
        {
          role: 'user',
          content:
            'Please navigate to https://news.ycombinator.com/, and then analyze the top 5 stories. Provide a summary of each story with its title and points/comments if available.',
        },
      ],
      tools: playwrightTools,
    });

    console.log('Playwright test result:', result.text);
  } catch (error) {
    console.error('Test error:', error);
    process.exit(1);
  } finally {
    // Clean up
    await cleanupMcp();
  }
}

// Run tests
main().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
