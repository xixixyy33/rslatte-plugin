const fs = require('fs');
const path = require('path');

// 目标目录
const PLUGIN_RELEASE_DIR = 'C:\\Users\\huang\\Desktop\\release\\plugin-release\\rslatte-plugin';
const CODE_RELEASE_DIR = 'C:\\Users\\huang\\Desktop\\release\\code-release\\rslatte-plugin';

// 构建产物文件列表
const BUILD_FILES = [
  'main.js',
  'main.js.map',
  'manifest.json',
  'styles.css',
];

// 过程类文档（不复制到 code-plugin）
const PROCESS_DOCS = [
  'REFACTORING_STATUS.md',
  'RSLatte-Hub-状态灯改造方案.md',
  'workEventSvc-分析报告.md',
  'space管理方案.md',
];

// 需要排除的目录和文件
const EXCLUDE_PATTERNS = [
  'node_modules',
  'dist',
  '.git',
  '.vscode',
  'main.js',
  'main.js.map',
  'audit.log',
  'scripts.build',
  '.gitignore',
  '.dockerignore',
  '.env',
  '.env.*',
];

/**
 * 判断文件是否应被排除
 */
function shouldExclude(filePath, relativePath) {
  const name = path.basename(filePath);
  const rel = relativePath || path.relative(__dirname, filePath);
  
  // 排除过程类文档（含 docs/ 下同名文件）
  if (PROCESS_DOCS.includes(name)) {
    return true;
  }
  
  // 排除构建产物（仅根目录，已单独处理）
  if (BUILD_FILES.includes(name) && !rel.includes(path.sep)) {
    return true;
  }
  
  // 排除目录模式（检查路径中是否包含）
  for (const pattern of EXCLUDE_PATTERNS) {
    if (rel.includes(pattern) || (name === pattern && !rel.includes(path.sep))) {
      return true;
    }
  }
  
  return false;
}

/**
 * 递归复制目录（排除指定文件/目录）
 */
function copyDir(src, dest, baseDir = src) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const relPath = path.relative(baseDir, srcPath);
    
    if (shouldExclude(srcPath, relPath)) {
      continue;
    }
    
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, baseDir);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 同步构建产物到 plugin-release/rslatte-plugin
 */
function syncBuildFiles() {
  try {
    if (!fs.existsSync(PLUGIN_RELEASE_DIR)) {
      fs.mkdirSync(PLUGIN_RELEASE_DIR, { recursive: true });
      console.log(`📁 Created: ${PLUGIN_RELEASE_DIR}`);
    }
    
    let syncedCount = 0;
    for (const file of BUILD_FILES) {
      const sourcePath = path.join(__dirname, file);
      const targetPath = path.join(PLUGIN_RELEASE_DIR, file);
      
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, targetPath);
        syncedCount++;
        console.log(`  ✓ Synced build file: ${file}`);
      } else {
        console.warn(`  ⚠ Build file not found: ${file}`);
      }
    }
    
    console.log(`✅ Synced ${syncedCount} build file(s) to ${PLUGIN_RELEASE_DIR}`);
  } catch (error) {
    console.error('❌ Sync build files failed:', error);
    throw error;
  }
}

/**
<<<<<<< HEAD
 * 清空 code-release 目录内容，但保留 .git（避免覆盖 Git 提交记录）
 */
function clearCodeReleaseDirExceptGit(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  }
}

/**
=======
>>>>>>> 70598913dd19bbdbf2ba1f028c2bc16c1e15503f
 * 同步源码到 plugin-release/code-plugin（排除过程类文档）
 */
function syncSourceCode() {
  try {
    if (!fs.existsSync(CODE_RELEASE_DIR)) {
      fs.mkdirSync(CODE_RELEASE_DIR, { recursive: true });
      console.log(`📁 Created: ${CODE_RELEASE_DIR}`);
    } else {
<<<<<<< HEAD
      clearCodeReleaseDirExceptGit(CODE_RELEASE_DIR);
      console.log(`📁 Cleared: ${CODE_RELEASE_DIR} (kept .git)`);
=======
      // 清空目标目录
      fs.rmSync(CODE_RELEASE_DIR, { recursive: true, force: true });
      fs.mkdirSync(CODE_RELEASE_DIR, { recursive: true });
      console.log(`📁 Cleared and recreated: ${CODE_RELEASE_DIR}`);
>>>>>>> 70598913dd19bbdbf2ba1f028c2bc16c1e15503f
    }
    
    // 复制源码目录
    const srcDirs = ['src', 'scripts', 'docs'];
    const srcFiles = ['package.json', 'package-lock.json', 'tsconfig.json'];
    
    // 复制目录
    for (const dir of srcDirs) {
      const srcPath = path.join(__dirname, dir);
      if (fs.existsSync(srcPath) && fs.statSync(srcPath).isDirectory()) {
        const destPath = path.join(CODE_RELEASE_DIR, dir);
        copyDir(srcPath, destPath, __dirname);
        console.log(`  ✓ Copied directory: ${dir}/`);
      }
    }
    
    // 复制文件（仅复制存在的文件）
    for (const file of srcFiles) {
      const srcPath = path.join(__dirname, file);
      if (fs.existsSync(srcPath) && !shouldExclude(srcPath)) {
        const destPath = path.join(CODE_RELEASE_DIR, file);
        fs.copyFileSync(srcPath, destPath);
        console.log(`  ✓ Copied file: ${file}`);
      }
    }
    
    // 可选文件（如果存在则复制）
    const optionalFiles = ['README.md', 'build.js', 'sync-release.js'];
    for (const file of optionalFiles) {
      const srcPath = path.join(__dirname, file);
      if (fs.existsSync(srcPath) && !shouldExclude(srcPath)) {
        const destPath = path.join(CODE_RELEASE_DIR, file);
        fs.copyFileSync(srcPath, destPath);
        console.log(`  ✓ Copied optional file: ${file}`);
      }
    }
    
    writeCodeReleaseGitignore(CODE_RELEASE_DIR, 'plugin');
    console.log(`✅ Synced source code to ${CODE_RELEASE_DIR} (excluded process docs)`);
  } catch (error) {
    console.error('❌ Sync source code failed:', error);
    throw error;
  }
}

/** code-release 用 .gitignore（发布到 GitHub 时排除敏感与冗余） */
function writeCodeReleaseGitignore(dir, type) {
  const base = `node_modules/\ndist/\n.env\n.env.*\n!.env.example\n.vscode/\n*.log\n.DS_Store\n`;
  const extra = type === 'backend' ? `__pycache__/\n*.pyc\npostgres/data/\n` : type === 'mobile' ? `data/\n` : '';
  fs.writeFileSync(path.join(dir, '.gitignore'), base + extra, 'utf8');
  console.log('  ✓ Wrote .gitignore');
}

// 执行同步
console.log('🚀 Starting release sync...\n');
syncBuildFiles();
console.log('');
syncSourceCode();
console.log('\n✨ Release sync completed!');
