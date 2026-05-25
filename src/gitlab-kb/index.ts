export { loadGitLabKbConfig, parseGitLabUrl, type GitLabKbConfig } from './config'
export { GitLabWikiClient, GitLabKbHttpError, slugFromTitle, type GitLabWikiPage } from './client'
export {
  encodeProjectId,
  inferProjectPathFromRepo,
  resolveGitLabKbTarget,
  type GitLabKbTarget
} from './project'
export {
  formatGitLabKbPage,
  formatGitLabKbPages,
  formatGitLabKbPublishResult,
  getGitLabKbStatus,
  parseGitLabKbPublishArgs,
  publishGitLabKbPage,
  readGitLabKbPage,
  searchGitLabKb
} from './operations'
