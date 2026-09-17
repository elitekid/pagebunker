# 가져오기 형식 확정 (T0.3, 2026-09-17)
출처: 위임 조사 1789611923-26045(공개 내보내기 원문·파서 코드 인용). 실제 계정 파일은 없음 — Pocket 공식 내보내기는 2025-11-12 종료(Mozilla 지원 문서 Wayback 2025-11-16).

## Pocket CSV (2024-10 이후, 이메일로 받은 ZIP 안에 약 1만 행씩 여러 장)
- 헤더 두 세대: title,url,time_added,cursor,tags,status / title,url,time_added,tags,status → 열 이름으로 찾는다.
- 쉼표 구분, RFC 4180 인용. time_added=유닉스 초. status=unread|archive. tags=파이프(|) 구분. 즐겨찾기·본문 없음.
- ZIP 파일 자체도 받는다: 안의 CSV를 모두 한 작업으로 합친다(annotations JSON은 무시). ZIP 지원이 v1 범위를 넘으면 "압축을 풀고 CSV를 모두 선택" 안내로 대체.
## Pocket 옛 HTML (ril_export.html)
- 넷스케이프 북마크 형식 아님. h1 Unread / h1 Read Archive 아래 li > a[href][time_added(초)][tags(쉼표)].
- Read Archive → 보관(읽음 아님).
## Instapaper CSV
- 헤더 두 세대: URL,Title,Selection,Folder / URL,Title,Selection,Folder,Timestamp,Tags → 열 이름으로 찾는다.
- Folder: Unread(읽을 글), Archive(보관), Starred(읽을 글+태그 starred), 그 외=사용자 폴더 이름 → 태그로.
- Timestamp=유닉스 초(없으면 가져온 시각, 행 순서 유지). Tags=JSON 배열 문자열("[]" 가능). Selection 무시.
## 브라우저 북마크 HTML (NETSCAPE-Bookmark-file-1)
- DT > A[HREF][ADD_DATE(초)], 폴더=DT > H3 + 중첩 DL. 폴더 경로를 태그로(선택). 파이어폭스 TAGS 속성(쉼표)도 태그로.
- 시간 자릿수 판별: 10자리=초, 13자리=밀리초.
