# سجل التغييرات

كل الإصدارات الموثقة لهذا المشروع تسرد أدناه. اتبع تنسيق [Keep a Changelog](https://keepachangelog.com/) واحترام إصدار [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2025-08-03

### المضاف

- إصدار أولي لتطبيق Nexus Voice مع:
  - خادم Express لتقديم الملفات الثابتة وواجهة API صغيرة لتهيئة ICE.
  - خادم Socket.IO لإدارة إشارات WebRTC بين الأقران.
  - واجهة أمامية داكنة مع تسع أسماء مستخدمين ثابتة، مؤثرات glitch وضوضاء.
  - دعم تحليل الصوت للكشف عن المتحدث الحالي.
  - سكربت start وcheckEnv وتشغيل عبر ngrok.
  - مثال إعداد coturn مع docker-compose.
  - اختبار ضغط باستخدام Puppeteer.