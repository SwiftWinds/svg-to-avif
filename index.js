#!/usr/bin/env node

const { glob } = require("glob");
const fs = require("fs").promises;
const path = require("path");
const { chromium } = require("playwright");

const GLOB_IGNORE = [
  "node_modules/**",
  "dist/**",
  "build/**",
  ".*/**", // Ignore all dot folders (includes .git, .vscode, etc.)
];

const currentDir = process.cwd();

console.log("Current directory:", currentDir);

async function updateReferences(originalName, newName) {
  console.log(`\nSearching for references to ${originalName}...`);

  // Search for all text files that might contain references
  const textFiles = await glob("**/*.{js,jsx,ts,tsx,html,css,scss,md,json}", {
    cwd: currentDir,
    ignore: GLOB_IGNORE,
  });

  for (const file of textFiles) {
    const filePath = path.join(currentDir, file);
    try {
      const content = await fs.readFile(filePath, "utf8");
      if (content.includes(originalName)) {
        console.log(`Updating references in ${file}`);
        const updatedContent = content.replace(
          new RegExp(originalName, "g"),
          newName
        );
        await fs.writeFile(filePath, updatedContent, "utf8");
      }
    } catch (error) {
      console.error(`Error processing ${file}:`, error);
    }
  }
}

async function convert(file) {
  console.log(`\nProcessing ${file.name}...`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(300000);

  const avifPath = path.join(file.dir, file.name.replace(".svg", ".avif"));
  console.log("Converting SVG to AVIF...");
  await page.goto("https://pixelied.com/convert/svg-converter/svg-to-avif");
  await page.getByLabel("Files Upload Input Box").click();
  await page.getByLabel("Files Upload Input Box").setInputFiles(file.path);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("slider").click();
  for (let i = 0; i < 100; i++) {
    await page.getByRole("slider").press("ArrowRight");
  }
  await page
    .locator("div")
    .filter({ hasText: /^Width \(Optional\)$/ })
    .getByRole("textbox")
    .click();
  await page
    .locator("div")
    .filter({ hasText: /^Width \(Optional\)$/ })
    .getByRole("textbox")
    .fill(file.width.toString());
  await page.getByRole("button", { name: "Convert To AVIF" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download AVIF" }).click();
  const download = await downloadPromise;
  await download.saveAs(avifPath);

  console.log("Compressing AVIF...");
  await page.goto("https://cloudinary.com/tools/compress-avif");
  await page.getByRole("button", { name: "↑ Upload" }).click();
  await page
    .locator('[data-test="uw-iframe"]')
    .contentFrame()
    .getByRole("textbox")
    .click();
  await page
    .locator('[data-test="uw-iframe"]')
    .contentFrame()
    .getByRole("textbox")
    .setInputFiles(avifPath);
  const compressedDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const compressedDownload = await compressedDownloadPromise;
  await compressedDownload.saveAs(avifPath);

  // After compression, check file sizes
  const avifStats = await fs.stat(avifPath);
  const svgStats = await fs.stat(file.path);
  
  if (avifStats.size >= svgStats.size) {
    console.log(`AVIF (${avifStats.size} bytes) is not smaller than SVG (${svgStats.size} bytes). Keeping SVG.`);
    await fs.unlink(avifPath); // Delete the AVIF file
    await context.close();
    await browser.close();
    return;
  }
  
  // If we get here, AVIF is smaller, so proceed with reference updates
  console.log(`AVIF (${avifStats.size} bytes) is smaller than SVG (${svgStats.size} bytes). Replacing...`);
  const originalName = file.name;
  const newName = originalName.replace(".svg", ".avif");
  await updateReferences(originalName, newName);

  console.log(`Completed ${file.name}`);
  await context.close();
  await browser.close();

  // Delete the SVG file after successful conversion
  console.log(`Deleting original SVG file: ${file.name}`);
  await fs.unlink(file.path);
}

async function main() {
  console.log("Searching for SVG files...");
  const files = await glob("**/*.svg", {
    cwd: currentDir,
    ignore: GLOB_IGNORE,
  });
  console.log(`Found ${files.length} SVG files`);

  console.log("Analyzing SVG files...");
  const svgFiles = (
    await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(currentDir, file);
        const stats = await fs.stat(filePath);
        const content = await fs.readFile(filePath, "utf8");
        
        // Only process if file is >= 10KB
        if (stats.size < 10 * 1024) {
          return null;
        }
        
        // Extract width for scaling
        const width = /<svg width="(.*?)"/.exec(content)?.[1];
        if (!width) {
          return null;
        }
        
        return {
          path: filePath,
          dir: path.dirname(filePath),
          name: path.basename(file),
          content,
          // obtained from https://www.desmos.com/calculator/qfdqaqaegs
          // we did a linear regression
          width: Math.round(3.12476 * Number(width) + 0.196661),
        };
      })
    )
  ).filter(Boolean);
  console.log(`Processing ${svgFiles.length} valid SVG files\n`);

  for (const file of svgFiles) {
    await convert(file);
  }
  console.log("\nAll files processed successfully!");
}

// Only run if called directly (not imported)
if (require.main === module) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
}
