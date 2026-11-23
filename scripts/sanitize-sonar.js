const fs = require('fs');
const path = require('path');

function sanitizeDoc(doc) {
  let changed = false;
  if (doc.weeklyMockPlans && typeof doc.weeklyMockPlans === 'object') {
    for (const day of Object.values(doc.weeklyMockPlans)) {
      if (day && day.stages && 'sonar' in day.stages) {
        const count = day.stages.sonar;
        delete day.stages.sonar;
        day.stages.cheetah = (day.stages.cheetah || 0) + count;
        changed = true;
      }
    }
  }

  if (doc.gameStats && 'sonar' in doc.gameStats) {
    delete doc.gameStats.sonar;
    changed = true;
  }

  if (Array.isArray(doc.mockExamHistory)) {
    doc.mockExamHistory.forEach(exam => {
      if (exam && exam.config && exam.config.stages && 'sonar' in exam.config.stages) {
        const count = exam.config.stages.sonar;
        delete exam.config.stages.sonar;
        exam.config.stages.cheetah = (exam.config.stages.cheetah || 0) + count;
        changed = true;
      }
      if (exam && Array.isArray(exam.perGameBreakdown)) {
        exam.perGameBreakdown.forEach(b => {
          if (b.gameId === 'sonar') {
            b.gameId = 'cheetah';
            b.gameName = 'EQ Cheetah';
            changed = true;
          }
        });
      }
      if (exam && Array.isArray(exam.questionResults)) {
        exam.questionResults.forEach(q => {
          if (q.gameId === 'sonar') {
            q.gameId = 'cheetah';
            q.gameName = 'EQ Cheetah';
            changed = true;
          }
        });
      }
    });
  }
  return changed;
}

// 1. Root progress.json
const rootPath = path.join(__dirname, '..', 'progress.json');
if (fs.existsSync(rootPath)) {
  const rootDoc = JSON.parse(fs.readFileSync(rootPath, 'utf8'));
  if (sanitizeDoc(rootDoc)) {
    fs.writeFileSync(rootPath, JSON.stringify(rootDoc));
    console.log('Sanitized root progress.json');
  }
}

// 2. Profile progress.json files
const profilesDir = path.join(__dirname, '..', 'profiles');
if (fs.existsSync(profilesDir)) {
  const entries = fs.readdirSync(profilesDir);
  entries.forEach(sub => {
    const profJson = path.join(profilesDir, sub, 'progress.json');
    if (fs.existsSync(profJson)) {
      try {
        const pDoc = JSON.parse(fs.readFileSync(profJson, 'utf8'));
        if (sanitizeDoc(pDoc)) {
          fs.writeFileSync(profJson, JSON.stringify(pDoc));
          console.log(`Sanitized profile: ${sub}`);
        }
      } catch (e) {}
    }
  });
}
console.log('Sonar sanitization complete.');
