/**
 * Quick visual test: renders reading-page PNGs with sample content
 * to verify layout fixes (title alignment, text truncation, top padding).
 */
import { writeZhihuReadingPagePngs } from "../../packages/pipeline/dist/index.js";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = join(import.meta.dirname, "test-layout-output");

const sampleTitle = "各位能不能讲一下自己真实的爱情故事?";
const sampleParagraphs = [
  "大一那年，我坐在图书馆靠窗的位置，阳光透过玻璃洒在桌面上。她抱着一摞书走过来，轻声问：这里有人吗？我摇摇头，心跳却突然加速。",
  "从那以后，她每天都会来同一个位置。我们开始默契地分享同一张桌子，却很少说话。直到有一天，她留下一张纸条：明天下午三点，操场见。",
  "我去了。她穿着白色连衣裙，站在跑道边。她说：我想和你一起跑步，一个人太无聊了。于是就这样认识了。",
  "几周后，第一次摸底考试结束，依照成绩排名将重新分配座位。我祈祷能和她坐近一些。命运似乎听到了我的心声——她被安排到了我前面。",
  "坐在吴的前面，我很快被她吸引。她写字很好看，笔记总是整整齐齐的。我尤其喜欢和她讨论数学大题，每次她回头讲解时，眼睛亮亮的。",
  "度过了无数个充实的日夜。我们一起上自习，一起在食堂排队，一起在校园散步。那些平凡的日子，现在回想起来都是金色的。",
  "毕业那天，她送了我一本书。扉页上写着：谢谢你那年的摇头。我笑了，眼眶却湿了。有些故事不需要轰轰烈烈，安静地发生，就已经很美好了。",
  "后来我们去了不同的城市。但每年图书馆靠窗的那个位置，我都会想起她抱着书走过来的样子。阳光刚好，微风不燥，一切都刚刚好。",
  "有人说大学里的爱情不真实。但我始终相信，那些在图书馆里相视一笑的瞬间，那些在操场上并肩奔跑的傍晚，都是生命中最真实的温柔。",
  "如果你问我后不后悔，我会说不后悔。即使最后没有在一起，那段时光也教会了我什么是心动，什么是珍惜，什么是放手后依然微笑。",
];

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const result = await writeZhihuReadingPagePngs(
    OUT_DIR,
    {
      sourceTitle: sampleTitle,
      paragraphs: sampleParagraphs,
      meta: {
        authorName: "匿名用户",
        authorBadge: "情感话题优秀回答者",
        answerCount: "2,847",
        followCount: "12.6万",
        avatarDataUri: null,
      },
      tags: ["爱情", "大学", "真实故事"],
      fullContentOutput: false,
      tailNote: "来知乎搜索「图书馆的爱情」可以看到全文",
    },
    {
      authorName: "匿名用户",
      authorBadge: "情感话题优秀回答者",
      answerCount: "2,847",
      followCount: "12.6万",
      avatarDataUri: null,
    },
  );

  console.log(`Generated ${result.pagePaths.length} pages:`);
  for (const p of result.pagePaths) {
    console.log(`  ${p}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
