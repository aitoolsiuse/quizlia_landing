// Renders the App Store QR to public/app-qr.svg (static asset — the URL
// never changes, so no runtime dependency). Rerun after changing the link.
import QRCode from "qrcode";
import { writeFile } from "fs/promises";

const URL = "https://apps.apple.com/us/app/quizliai/id6751740981";

const svg = await QRCode.toString(URL, {
  type: "svg",
  margin: 1,
  width: 240,
  color: { dark: "#000000", light: "#FFFFFF" },
});

await writeFile("public/app-qr.svg", svg, "utf8");
console.log("wrote public/app-qr.svg ->", URL);
