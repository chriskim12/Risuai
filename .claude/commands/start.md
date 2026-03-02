# start

서버 DB를 로컬로 동기화하고 로컬 Docker 환경을 시작합니다.

## Steps

Run the following commands sequentially using the Bash tool:

**1. DB 동기화**
```bash
rsync -az \
  -e "ssh -i /home/chris/risu/ssh-key-2026-03-02.key -o StrictHostKeyChecking=no" \
  ubuntu@150.230.7.17:~/risuai/save/64617461626173652f64617461626173652e62696e \
  ubuntu@150.230.7.17:~/risuai/save/__password \
  /home/chris/risu/Risuai/save/
```

**2. 로컬 Docker 시작**
```bash
cd /home/chris/risu/Risuai && docker compose up -d
```

- 완료되면 `http://localhost:6001` 접속하면 된다고 알려줍니다.
- 실패하면 에러 메시지를 보여주고 원인을 분석합니다.
