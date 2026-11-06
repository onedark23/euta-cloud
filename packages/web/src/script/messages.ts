// Korean wording for engine messages shown in the editor. `friendly` is euta-app
// src/main/project/script-detail.ts `friendly`, `koSecretRule` is euta-app src/shared/secret-rules.ts
// (copied — keep in step, see ADR-029).

/** Korean for the schema messages a form user can hit (duration / size text). */
export function friendly(message: string): string {
  if (/must match pattern .*\(ms\|s\|m(\|h)?\)/.test(message)) return '시간 형식이 아닙니다 (예: 500, 2s, 1m)';
  if (/must match pattern .*\(b\|kb\|mb/i.test(message)) return '크기 형식이 아닙니다 (예: 512b, 10kb, 2mb)';
  return koSecretRule(message);
}

/** Korean wording of the engine's secret-rule messages inside `message`; the rest of the text is kept. */
export function koSecretRule(message: string): string {
  return message
    .replace(
      /\$\{secrets\.([^}]+)\} is only allowed in the value of a fill or type step(?: \(secret placement rule\)| in cloud runs)?/g,
      (_m, name: string) => `\${secrets.${name}} 는 입력 스텝(fill 의 value · type 의 text)에만 쓸 수 있습니다 — 주소·변수·확인·이름 등에 넣으면 테스트 계정이 바깥으로 나갈 수 있어 실행하지 않습니다 (secrets 규칙)`,
    )
    .replace(/secret input blocked: page host "([^"]*)" is not an allowed domain \(([^)]*)\)/g, (_m, host: string, list: string) =>
      list === 'no allowed domains configured'
        ? `테스트 계정 입력 차단: 이 환경에 허용 도메인이 없습니다(지금 페이지 "${host}") — 설정 → 환경에서 주소 또는 허용 도메인을 넣으세요 (secrets 규칙)`
        : `테스트 계정 입력 차단: 지금 페이지 "${host}" 는 허용 도메인(${list})이 아닙니다 — 설정 → 환경 → 허용 도메인에 추가하세요 (secrets 규칙)`,
    );
}

/** "3번 단계" for a validation path like `steps[2].click.target`, else the path. */
export function issueWhere(path: string, stepPath: number[] | undefined): string {
  if (stepPath) return `${stepPath.map((i) => i + 1).join('.')}번 단계`;
  return path || '(스크립트)';
}
