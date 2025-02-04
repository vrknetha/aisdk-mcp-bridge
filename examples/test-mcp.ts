import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { getMcpTools, cleanupMcp, initializeMcp } from '../src';
import dotenv from 'dotenv';
dotenv.config();

async function runTest() {
  try {
    console.log('Starting MCP test...');

    // Initialize MCP
    await initializeMcp({ debug: true });

    // Get MCP tools
    const tools = await getMcpTools({ serverName: 'firecrawl' });

    // Use tools with generateText - let the LLM figure out tool usage
    const result = await generateText({
      model: google('gemini-1.5-pro'),
      prompt:
        'Please analyze the current trennds using https://www.techtarget.com/searchenterpriseai/tip/9-top-AI-and-machine-learning-trends',
      tools,
    });
    return true;
  } catch (error) {
    console.error('Test failed:', error);
    return false;
  }
}

async function runHttpTest() {
  console.log('Running HTTP server test...');
  try {
    // Initialize MCP with HTTP server
    await initializeMcp();

    // Get tools from HTTP server
    const tools = await getMcpTools({ serverName: 'http-server' });
    console.log('HTTP server tools:', tools);

    // Test echo tool using generateText
    const result = await generateText({
      model: google('gemini-1.5-pro'),
      prompt: 'Please echo back the message "Hello from HTTP test!"',
      tools,
    });
    console.log('Echo test result:', result.text);

    console.log('HTTP server test completed successfully');
  } catch (error) {
    console.error('HTTP server test failed:', error);
  }
}

async function runSseTest() {
  console.log('Running SSE server test...');
  try {
    // Initialize MCP with SSE server
    await initializeMcp();

    // Get tools from SSE server
    const tools = await getMcpTools({ serverName: 'sse-server' });
    console.log('SSE server tools:', tools);

    // Test subscribe tool using generateText
    const result = await generateText({
      model: google('gemini-1.5-pro'),
      prompt: 'Please subscribe to the "test-topic" topic',
      tools,
    });
    console.log('Subscribe test result:', result.text);

    console.log('SSE server test completed successfully');
  } catch (error) {
    console.error('SSE server test failed:', error);
  }
}

async function runTests() {
  try {
    await runTest();
    await cleanupMcp();

    await runHttpTest();
    await cleanupMcp();

    await runSseTest();
    await cleanupMcp();

    console.log('All tests completed');
  } catch (error) {
    console.error('Test suite failed:', error);
  }
}

// Run the tests
runTests();
