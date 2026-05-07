const { chromium } = require("playwright-extra");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const stealth = require("puppeteer-extra-plugin-stealth")();
require("dotenv").config();

// Stealth 플러그인 사용 (봇 탐지 우회)
chromium.use(stealth);

async function extractTextWithGemini(imageUrl) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY가 설정되어 있지 않습니다.");
  }

  // 1. SDK 초기화
  const genAI = new GoogleGenerativeAI(apiKey);
  // v1beta 엔드포인트를 자동으로 사용하도록 설정된 최신 모델 지정
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

  // 2. 이미지 데이터 가져오기
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`이미지 다운로드 실패: ${imgRes.status}`);
  }

  const mimeType =
    imgRes.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
  const bytes = await imgRes.arrayBuffer();

  const prompt = `
  이 이미지에서 오늘의 뷔페 메뉴 정보를 추출해줘.
  
  추출 및 필터링 규칙:
  1. 이미지에 'x월 x일(요일) 더온담의 메뉴'형식의 텍스트가 포함되어 있을 경우에만 추출, 없다면 추출하지 말고 빈 문자열("")만 반환할 것.
  2. 메뉴 이름이 한두 개만 적혀 있거나, 전체 식단표가 아닌 단일 메뉴 홍보 이미지인 경우추출하지 말고 빈 문자열("")만 반환할 것.
  3. 출력 형식: 메뉴들만 줄바꿈하여 나열.
`.trim();

  try {
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: Buffer.from(bytes).toString("base64"),
          mimeType,
        },
      },
    ]);

    const response = await result.response;
    return response.text().trim();
  } catch (error) {
    // 429(Quota) 에러 등이 발생할 경우 상세 메시지 출력
    if (error.message.includes("429")) {
      throw new Error("Gemini API 할당량 초과입니다. 잠시 후 다시 시도하세요.");
    }
    throw error;
  }
}

function parseMenuLines(menuText) {
  return (menuText || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function sendToTeamsWebhook({ webhookUrl, title, lines }) {
  if (!webhookUrl) {
    throw new Error(
      "TEAMS_WEBHOOK_URL이 설정되어 있지 않습니다. (.env에 TEAMS_WEBHOOK_URL=... 추가)",
    );
  }

  const menuText = Array.isArray(lines) ? lines.join("\n") : "";
  const payload = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          body: [
            {
              type: "TextBlock",
              text: title || "오늘의 메뉴",
              weight: "Bolder",
              size: "Large",
              wrap: true,
            },
            {
              type: "TextBlock",
              text: menuText || "(추출된 텍스트 없음)",
              wrap: true,
              fontType: "Monospace",
            },
          ],
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          version: "1.4",
        },
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const responseBody = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `Teams 웹훅 전송 실패: ${res.status} ${res.statusText}${responseBody ? `\n${responseBody}` : ""}`,
    );
  }

  // 성공 여부 확인용 로그(Teams는 종종 "1" 같은 본문을 돌려줍니다)
  return { status: res.status, statusText: res.statusText, body: responseBody };
}
(async () => {
  // 1. 브라우저 실행 (눈으로 확인하려면 headless: false)
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const profileUrl = "https://www.instagram.com/the.ondam/";

    // 1~3회: 인스타그램 접속 자체를 재시도 (10초 간격)
    // "접속 성공"의 기준은 프로필에서 article img가 1개 이상 잡히는 것으로 둡니다.
    let total = 0;
    const images = page.locator("article img");
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`인스타그램 접속 중... (${attempt}/3)`);

      await page.goto(profileUrl, { waitUntil: "networkidle" });

      // 로그인 유도 모달 처리
      const modalCloseButton = page.locator(
        'div[role="dialog"] [aria-label="닫기"], div[role="dialog"] svg[aria-label="닫기"]',
      );
      if (await modalCloseButton.isVisible().catch(() => false)) {
        console.log("모달 발견, 닫는 중...");
        await modalCloseButton.click().catch(() => {});
      }

      total = await images.count();
      if (total > 0) break;

      if (attempt < 3) {
        console.log("이미지를 찾을 수 없습니다. 10초 후 접속 재시도합니다...");
        await sleep(10_000);
      }
    }

    const limit = Math.min(total, 2);
    if (limit === 0) {
      console.log(
        "이미지를 찾을 수 없습니다. (로딩/로그인 유도/DOM 변경 가능) 셀렉터를 확인해보세요.",
      );
      return;
    }

    let todayMenu = null;

    for (let i = 0; i < limit; i++) {
      const imageUrl = await images.nth(i).getAttribute("src");
      console.log("------------------------------------");
      console.log(`(${i + 1}/${limit}) 추출된 이미지 URL:`, imageUrl);
      console.log("------------------------------------");

      if (!imageUrl) continue;

      try {
        const menuText = await extractTextWithGemini(imageUrl);
        const menuArr = parseMenuLines(menuText);
        console.log("===== 메뉴 텍스트(OCR) =====");
        console.log(
          menuArr.length ? menuArr.join("\n") : "(추출된 텍스트 없음)",
        );
        console.log("===========================");

        // 메뉴가 5개 이상이면 '오늘의 메뉴'로 확정
        if (menuArr.length >= 5) {
          todayMenu = menuArr;
          break;
        }
      } catch (e) {
        console.error("OCR 실패:", e?.message || e);
      }
    }

    console.log("########## 오늘의 메뉴 ##########");
    if (todayMenu?.length) {
      console.log(todayMenu.join("\n"));
    } else {
      console.log(
        "(오늘의 메뉴를 확정하지 못했습니다: 5개 이상 메뉴를 가진 이미지가 없음)",
      );
    }
    console.log("###############################");

    if (todayMenu?.length) {
      try {
        const result = await sendToTeamsWebhook({
          webhookUrl: process.env.TEAMS_WEBHOOK_URL,
          title: "오늘의 메뉴",
          lines: todayMenu,
        });
        console.log(
          `Teams 웹훅 전송 완료 (HTTP ${result.status} ${result.statusText})`,
        );
        if (result.body) console.log("Teams 응답 본문:", result.body);
      } catch (e) {
        console.error("Teams 웹훅 전송 실패:", e?.message || e);
      }
    }
  } catch (error) {
    console.error("에러 발생:", error);
  } finally {
    await browser.close();
  }
})();
