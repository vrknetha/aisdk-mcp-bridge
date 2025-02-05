import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { getMcpTools, initializeMcp, cleanupMcp } from '../src';

import dotenv from 'dotenv';
dotenv.config();

async function main() {
  try {
    // Initialize MCP
    await initializeMcp({ debug: true });

    // Test Twitter server
    console.log('\nTesting Twitter MCP server...');
    const twitterTools = await getMcpTools({ serverName: 'twitter-mcp' });

    // Search and analyze tweets
    const result = await generateText({
      model: google('gemini-1.5-flash'),
      messages: [
        {
          role: 'system',
          content:
            'You are a social media analyst specializing in AI technology trends. Use the Twitter search tools to find and analyze recent discussions about AI technologies.',
        },
        {
          role: 'user',
          content: `Please perform the following analysis:
1. Search for recent tweets about "GenAI" and "LLM" (use multiple searches if needed)
2. Focus on tweets with high engagement (likes, retweets)
3. Analyze the main themes and sentiments in these discussions
4. Provide a summary of:
   - Key trends and topics being discussed
   - Notable opinions or insights
   - Common concerns or challenges mentioned
   - Any interesting predictions or future outlook`,
        },
      ],
      tools: twitterTools,
    });

    console.log('Twitter analysis result:', result.text);
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
