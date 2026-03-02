# deploy

서버에 최신 코드를 배포합니다. SSH로 접속해 git pull 후 pnpm build를 실행합니다.

## Steps

Run the following command using the Bash tool:

```bash
ssh -i /home/chris/risu/ssh-key-2026-03-02.key -o StrictHostKeyChecking=no ubuntu@150.230.7.17 "cd ~/risuai && git pull && pnpm build"
```

- 실시간 출력을 사용자에게 보여줍니다.
- 성공하면 "배포 완료" 를 알려줍니다.
- 실패하면 에러 메시지를 보여주고 원인을 분석합니다.
