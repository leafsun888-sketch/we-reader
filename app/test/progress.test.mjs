import test from 'node:test';
import assert from 'node:assert/strict';
import { latestArchiveProgress } from '../lib/progress.mjs';

test('读取最新的结构化归档进度', () => {
  const output = [
    'Second Brain 书库已更新。',
    'WE_READ_ARCHIVE_PROGRESS {"completed":0,"total":12,"archived":0,"failed":0}',
    'WE_READ_ARCHIVE_PROGRESS {"completed":5,"total":12,"archived":4,"failed":1}',
  ].join('\n');
  assert.deepEqual(latestArchiveProgress(output), {
    stage: 'archiving', completed: 5, total: 12, archived: 4, failed: 1,
  });
});

test('损坏或缺失的进度行不会影响任务状态', () => {
  assert.equal(latestArchiveProgress('普通输出'), null);
  assert.equal(latestArchiveProgress('WE_READ_ARCHIVE_PROGRESS {bad json}'), null);
});
