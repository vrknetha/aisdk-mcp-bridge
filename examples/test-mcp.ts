import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { getMcpTools, initializeMcp, cleanupMcp } from '../src';

import dotenv from 'dotenv';
dotenv.config();

async function main() {
  try {
    // Initialize MCP
    await initializeMcp({ debug: true });

    // Test firecrawl server
    console.log('\nTesting firecrawl server...');
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
    console.log('Firecrawl test result:', firecrawlResult.text);

    // Test SSE server
    console.log('\nTesting SSE server...');
    const sseTools = await getMcpTools({ serverName: 'sse-server' });
    const sseResult = await generateText({
      model: google('gemini-1.5-flash'),
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that manages subscriptions.',
        },
        {
          role: 'user',
          content: 'Please subscribe to the "test-topic" topic',
        },
      ],
      tools: sseTools,
    });
    console.log('SSE test result:', sseResult.text);
  } catch (error) {
    console.error('Test error:', error);
    process.exit(1);
  } finally {
    // Clean up
    await cleanupMcp();
  }
}

// Handle process signals
process.on('SIGINT', async () => {
  console.log('\nSIGINT received. Cleaning up...');
  await cleanupMcp();
  process.exit(1);
});

// Run tests
main().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
