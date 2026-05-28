/**
 * 兼容开发态入口：委托给薄 CLI bootstrap，让 `tsx src/index.ts` 与发布产物
 * 使用同一套早期命令、动态 import 与启动诊断路径。
 */
import './cli/bootstrap';
