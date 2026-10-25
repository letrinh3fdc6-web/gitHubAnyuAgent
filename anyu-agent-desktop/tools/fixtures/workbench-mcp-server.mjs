import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'anyu-test-connector', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'Return test input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }))
server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: String(request.params.arguments.text) }] }))
await server.connect(new StdioServerTransport())
