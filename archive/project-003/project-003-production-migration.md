# PROJECT 003 — Backup và migration production

Thời điểm thực hiện: 16-07-2026 (Asia/Saigon).

## Dry-run trước migration

- Job: 5; Job có pipeline version: 0.
- TranslationChunk: 6; cả 6 là legacy final chunk.
- Quality chunk: 0; quality chunk dở: 0.
- `modifiedCount = 0`; dry-run không đồng bộ index.

## Backup

- File ngoài repository: `Tran-backups/p003-before-migration-2026-07-15T18-30-09-916Z.ejson.gz`.
- Format: `P003_EJSON_BACKUP_V1`; gzip EJSON, 26.881 byte.
- SHA-256: `513a038a6f1dac6c98bab8830d97430db91f3fbe2bc4a8804a11e2879ad607c4`.
- Collection: 5 `jobs`, 6 `translationchunks`, 0 `uploadbatches`, 0 `systems`; index của cả bốn collection được lưu cùng payload.
- Backup đã được giải nén và parse lại thành công trước migration; không in nội dung document hoặc credential.

## Migration và hậu kiểm

- Migration additive hoàn thành, không rewrite document (`modifiedCount = 0`).
- `Job.syncIndexes()` và `TranslationChunk.syncIndexes()` hoàn thành (`indexesEnsured = true`).
- Dry-run hậu kiểm giữ nguyên 5 Job, 6 legacy final chunk, 0 quality chunk và 0 quality chunk dở.
- Chưa deploy code, chưa đổi `TRANSLATION_PIPELINE_MODE` và chưa tạo canary quality tại bước này.
