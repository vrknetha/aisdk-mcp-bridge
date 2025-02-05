import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { getMcpTools, initializeMcp, cleanupMcp } from '../src';

import dotenv from 'dotenv';
import { log } from '../src/tools';
dotenv.config();

async function main() {
  try {
    // Initialize MCP
    await initializeMcp({ debug: true });

    // Test firecrawl server
    log('\nTesting firecrawl server...');
    const firecrawlTools = await getMcpTools({ serverName: 'firecrawl' });
    const firecrawlResult = await generateText({
      model: google('gemini-1.5-flash'),
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that analyzes web content.',
        },
        {
          role: 'user',
          content:
            'Please analyze the current trends using https://www.techtarget.com/searchenterpriseai/tip/9-top-AI-and-machine-learning-trends',
        },
      ],
      tools: firecrawlTools,
    });
    log('Firecrawl test result:', firecrawlResult.text);
  } catch (error) {
    log('Test error:', error);
    process.exit(1);
  } finally {
    // Clean up
    await cleanupMcp();
  }
}

// Run tests
main().catch(error => {
  log('Test failed:', error);
});
