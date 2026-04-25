# Warning Things

## 정책 결정 및 처리 현황

- 승인 게이트 생략: 사용자가 마이그레이션 완료 전까지 멈추지 말라고 명시했으므로, Superpowers brainstorming/planning의 중간 승인 게이트 생략을 이번 작업의 예외로 인정한다. 추가 조치는 하지 않고 이 문서에만 기록한다.
- 작업 브랜치: 작업은 `main`에서 직접 진행한 커밋으로 유지한다. 원격에는 푸쉬하지 않는다.
- `codex app-server`: Codex CLI에서 experimental로 표시된 기능이지만 제품 동작으로 수용한다. 구현 전 `codex app-server generate-ts`와 WebSocket probe로 현재 로컬 프로토콜은 확인했다. 향후 Codex CLI 업데이트에서 프로토콜이 바뀔 수 있다는 점은 README에 명시한다.
- Discord slash command: `/opencode` alias는 유지하지 않고 `/codex`만 지원한다. 기존 설치 환경에서는 `remote-codex deploy`로 slash command를 다시 배포해야 한다.
- 설치 정책: OpenCode 전용 native 의존성을 제거했으므로 정상 설치는 `npm ci`가 lifecycle scripts 포함 상태로 통과해야 한다. `npm ci`를 재실행해 통과를 확인했다.
- 보안 감사 정책: 런타임 의존성만 우선 처리한다. `npm audit --omit=dev` 기준 취약점은 `undici`와 `lodash` override로 해결했고, 현재 0 vulnerabilities다. 전체 `npm audit`에는 dev 도구 체인(`vite`, `postcss`, `picomatch`) 취약점 3건이 남아 있으며, 런타임 영향은 없는 것으로 분리한다.
- Codex 세션 재사용: `thread/read` 성공은 실행 가능한 세션을 의미하지 않는다. app-server 재시작 후 저장된 thread는 `thread/resume`으로 로드해야 하며, `status.type === "idle"`이고 모델 메타데이터가 있는 경우에만 재사용한다. 그 외 `notLoaded`, `active`, `systemError`, `model: ""` 상태로 resume되는 과거 세션은 새 thread로 fallback한다.
- Codex 모델 기본값: 채널에 모델이 설정되지 않은 상태를 빈 문자열 `""`로 전달하면 Codex app-server가 빈 모델 thread를 만들고 이후 `Invalid request payload` 오류가 난다. 기본 모델 사용 시 `model` 필드는 생략하고, app-server 응답의 모델 메타데이터가 비어 있으면 해당 thread를 저장하지 않는다.
- WebSocket 종료 이벤트: Codex app-server WebSocket은 클라이언트가 의도적으로 닫아도 Node 런타임에서 `error`/`1006` 이벤트가 뒤따를 수 있다. 사용자에게 잘못된 `Connection error`가 노출되지 않도록 의도적 종료는 연결 장애로 처리하지 않는다.

## 검증 명령

- `npm ci`
- `npm audit --omit=dev`
- `npm run build`
- `npm test`
- `CodexAppClient` 실사용 probe: 저장된 broken thread resume 거부 후 새 thread fallback 및 `turn/start` 응답 `OK` 확인
