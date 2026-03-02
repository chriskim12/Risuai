# pull-db

서버의 save 폴더 전체를 로컬로 동기화합니다.

## Steps

Run the following commands using the Bash tool:

```bash
mkdir -p /home/chris/risu/Risuai/save && \
rsync -az --progress \
  -e "ssh -i /home/chris/risu/ssh-key-2026-03-02.key -o StrictHostKeyChecking=no" \
  ubuntu@150.230.7.17:~/risuai/save/ \
  /home/chris/risu/Risuai/save/
```

- 완료되면 "동기화 완료" 를 알려줍니다.
- 실패하면 에러 메시지를 보여주고 원인을 분석합니다.
- 첫 실행은 1.3GB라 시간이 걸리지만, 이후 실행은 변경분만 받아옵니다.
