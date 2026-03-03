# deploy

서버에 최신 코드를 배포합니다. 미커밋 변경사항이 있으면 커밋 및 푸시 후 배포합니다.

## Steps

1. `git status`로 미커밋 변경사항을 확인합니다.

2. 변경사항이 있으면:
   - 변경된 파일 목록과 diff를 확인하고 적절한 커밋 메시지를 작성합니다.
   - `git add -A`로 모든 변경사항을 스테이징합니다.
   - 커밋 메시지는 변경 내용을 반영해 작성합니다 (Co-Authored-By 포함).
   - `git push`로 푸시합니다.

3. 변경사항이 없으면 커밋/푸시 단계를 건너뜁니다.

4. SSH로 서버에 접속해 배포합니다:

```bash
ssh -i /home/chris/risu/ssh-key-2026-03-02.key -o StrictHostKeyChecking=no ubuntu@150.230.7.17 "cd ~/risuai && git pull && docker compose up --build -d"
```

- 실시간 출력을 사용자에게 보여줍니다.
- 성공하면 "배포 완료"를 알려줍니다.
- 실패하면 에러 메시지를 보여주고 원인을 분석합니다.
