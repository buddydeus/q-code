import { jsonSchema } from 'ai'

export const weatherTool = {
  name: 'weather',
  description: '获取天气信息',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      city: {
        type: 'string',
        description: '城市名称'
      }
    },
    required: ['city']
  }),
  execute: async (args: { city: string }) => {
    // 这里可以调用天气API
    return `天气信息：${args.city}的天气是晴天`
  }
}
