# Warning Things

## 정책 결정 및 처리 현황

- 승인 게이트 생략: 사용자가 마이그레이션 완료 전까지 멈추지 말라고 명시했으므로, Superpowers brainstorming/planning의 중간 승인 게이트 생략을 이번 작업의 예외로 인정한다. 추가 조치는 하지 않고 이 문서에만 기록한다.
- 작업 브랜치: 작업은 `main`에서 직접 진행한 커밋으로 유지한다. 원격에는 푸쉬하지 않는다.
- `codex app-server`: Codex CLI에서 experimental로 표시된 기능이지만 제품 동작으로 수용한다. 구현 전 `codex app-server generate-ts`와 WebSocket probe로 현재 로컬 프로토콜은 확인했다. 향후 Codex CLI 업데이트에서 프로토콜이 바뀔 수 있다는 점은 README에 명시한다.
- Discord slash command: `/opencode` alias는 유지하지 않고 `/codex`만 지원한다. 기존 설치 환경에서는 `remote-codex deploy`로 slash command를 다시 배포해야 한다.
- 설치 정책: OpenCode 전용 native 의존성을 제거했으므로 정상 설치는 `npm ci`가 lifecycle scripts 포함 상태로 통과해야 한다. `npm ci`를 재실행해 통과를 확인했다.
- 보안 감사 정책: 런타임 의존성만 우선 처리한다. `npm audit --omit=dev` 기준 취약점은 `undici`와 `lodash` override로 해결했고, 현재 0 vulnerabilities다. 전체 `npm audit`에는 dev 도구 체인(`vite`, `postcss`, `picomatch`) 취약점 3건이 남아 있으며, 런타임 영향은 없는 것으로 분리한다.

## 검증 명령

- `npm ci`
- `npm audit --omit=dev`
- `npm run build`
- `npm test`
