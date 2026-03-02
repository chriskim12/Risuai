# pull-db

서버의 database.bin을 로컬로 동기화합니다.

## Steps

Run the following commands using the Bash tool:

```bash
mkdir -p /home/chris/risu/Risuai/save && \
rsync -avz --progress \
  -e "ssh -i /home/chris/risu/ssh-key-2026-03-02.key -o StrictHostKeyChecking=no" \
  ubuntu@150.230.7.17:~/risuai/save/64617461626173652f64617461626173652e62696e \
  ubuntu@150.230.7.17:~/risuai/save/__password \
  /home/chris/risu/Risuai/save/
```

- 완료되면 "DB 동기화 완료" 를 알려줍니다.
- 실패하면 에러 메시지를 보여주고 원인을 분석합니다.

## 파일 설명

| 서버 경로 | 실제 경로 |
|-----------|-----------|
| `64617461626173652f64617461626173652e62696e` | `database/database.bin` (hex-encoded) |
| `__password` | 앱 패스워드 파일 |
