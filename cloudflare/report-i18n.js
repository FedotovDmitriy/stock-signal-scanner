const TEXT = {
  en: {
    analysisTitle: "Analysis report", status: "Status", price: "Price", movement: "Movement",
    distanceFromMma: "distance from MMA150", signals: "Signals", why: "Why", condition: "Condition",
    idea: "Idea", stop: "Stop", target: "Target", risk: "Risk", noSignal: "No signal",
    noSignalDetails: "Entry conditions were not confirmed.", noData: "Not enough data for analysis", error: "Error",
    signalFor: "Signal for {ticker}", strategy: "Strategy", unavailable: "unavailable",
    side_long: "long", side_short: "short", strategy_Trend_Following: "Trend following",
    strategy_Breakout_Trading: "Breakout trading", strategy_Volume_Profile_AVWAP: "Volume profile and AVWAP", strategy_Momentum_Trading: "Momentum trading",
    trendAbove: "price is above EMA200", trendBelow: "price is below EMA200", trendNear: "price is near EMA200",
    mmaDistance: "distance from MMA150: {distance}", momentumPositive: "positive momentum",
    momentumNegative: "negative momentum", momentumNeutral: "neutral momentum",
    trendLongCondition: "price is above EMA200 and AVWAP", trendShortCondition: "price is below EMA200 and AVWAP",
    trendLongIdea: "possible long", trendShortIdea: "possible short",
    breakoutLongCondition: "breakout above the 20-candle high", breakoutShortCondition: "breakdown below the 20-candle low",
    breakoutLongIdea: "momentum long", breakoutShortIdea: "momentum short",
    volumeLongCondition: "price is above AVWAP and POC", volumeShortCondition: "price is below AVWAP and POC",
    volumeLongIdea: "buyers remain in control", volumeShortIdea: "sellers remain in control",
    momentumCondition: "ROC20 {roc}% and RSI14 {rsi}", momentumLongIdea: "upside momentum is strengthening",
    momentumShortIdea: "downside momentum is strengthening",
    fundSummary: "FundRep KPI summary", valuation: "Valuation", growth: "Growth", profitability: "Profitability",
    debt: "Debt", momentum: "Momentum", keyRisks: "Key risks", reportDate: "Date",
    disclaimer: "Not investment advice.", metric: "Metric", value: "Value", explanation: "Explanation",
    fundTitle: "Fundamental report for {ticker}", dataFull: "Yahoo Finance fundamental data received.",
    dataPartial: "Only partial Yahoo Finance data is available.", dataUnavailable: "Fundamental data is unavailable.",
    quickGuide: "Profitability shows earnings quality; Valuation shows price; Cash Flow shows real cash generation; Financial Health shows balance-sheet strength; Forward Signals show changing market expectations.",
    promptIntro: "Use this prompt in Perplexity Finance:", promptRequest: "Prepare a professional PDF report for ticker {ticker}.",
    promptStructure: "Report structure", promptInputs: "Current technical inputs", promptFinal: "For every KPI, explain what it means, why it changed, how it affects investors, and what to monitor next. Present the result as a modern analytical dashboard with charts, KPI cards, and a concise investment conclusion.",
    prompt1: "Income Statement: revenue, margins, profit, trends, and reasons for changes.", prompt2: "Momentum: price trend, relative strength, RSI, volume, and key levels.",
    prompt3: "Valuation History: multiples compared with company history and the sector. Include CAPE, its calculation method, company-level limitations, and a conclusion based on normalized earnings.",
    prompt4: "Capital and Conviction: balance sheet, debt, buybacks, and insider and institutional activity.",
    reportFailed: "could not retrieve data",
    status_signal_found: "signal found", status_no_signal: "no signal", status_not_enough_data: "not enough data",
    status_invalid_ticker: "invalid ticker", status_data_provider_error: "data provider error", status_partial_result: "partial result",
    revenue: "Revenue", earnings: "Earnings", gross: "Gross margin", operating: "Operating margin", net: "Net margin",
    cash: "Cash", change: "Change", marketCap: "Market cap", currentRatio: "Current ratio",
    fundSection1: "1. Profitability", fundQuestion1: "Is the company generating real earnings and becoming more efficient?",
    fundSection2: "2. Valuation", fundQuestion2: "Is this a good company at a reasonable price?",
    fundSection3: "3. Cash flow", fundQuestion3: "Do accounting earnings turn into real free cash flow?",
    fundSection4: "4. Financial health", fundQuestion4: "Can the company withstand a downturn and finance growth?",
    fundSection5: "5. Forward signals", fundQuestion5: "How are expectations for the company changing?",
    metricExplanationGeneric: "Review this metric against company history, peers, and the latest filings.",
    riskDebt: "Debt is high relative to equity.", riskLiquidity: "Current liquidity is below 1.",
    riskValuation: "The P/E valuation appears demanding.", riskRevenue: "Revenue is declining.",
    riskOverbought: "The stock may be technically overbought based on RSI.", riskWeak: "The stock is technically weak based on RSI.",
    riskDefault: "Key risks should be verified against the latest filings and news.",
    marketNews: "Market news", country: "Country", source: "Source", published: "Published", tickers: "Tickers",
  },
  ru: {
    analysisTitle: "Отчёт анализа", status: "Статус", price: "Цена", movement: "Движение",
    distanceFromMma: "от MMA150", signals: "Сигналы", why: "Почему", condition: "Условие",
    idea: "Идея", stop: "Стоп", target: "Цель", risk: "Риск", noSignal: "Нет сигнала",
    noSignalDetails: "Условия входа не подтвердились.", noData: "Недостаточно данных для анализа", error: "Ошибка",
    signalFor: "Сигнал по {ticker}", strategy: "Стратегия", unavailable: "недоступно",
    side_long: "покупка", side_short: "продажа", strategy_Trend_Following: "Следование за трендом",
    strategy_Breakout_Trading: "Торговля пробоя", strategy_Volume_Profile_AVWAP: "Профиль объёма и AVWAP", strategy_Momentum_Trading: "Торговля по моментуму",
    trendAbove: "цена выше EMA200", trendBelow: "цена ниже EMA200", trendNear: "цена около EMA200",
    mmaDistance: "расстояние от MMA150: {distance}", momentumPositive: "положительный моментум",
    momentumNegative: "отрицательный моментум", momentumNeutral: "нейтральный моментум",
    trendLongCondition: "цена выше EMA200 и AVWAP", trendShortCondition: "цена ниже EMA200 и AVWAP",
    trendLongIdea: "возможная длинная позиция", trendShortIdea: "возможная короткая позиция",
    breakoutLongCondition: "пробой 20-свечного максимума", breakoutShortCondition: "пробой 20-свечного минимума",
    breakoutLongIdea: "импульсная длинная позиция", breakoutShortIdea: "импульсная короткая позиция",
    volumeLongCondition: "цена выше AVWAP и POC", volumeShortCondition: "цена ниже AVWAP и POC",
    volumeLongIdea: "покупатели удерживают контроль", volumeShortIdea: "продавцы удерживают контроль",
    momentumCondition: "ROC20 {roc}% и RSI14 {rsi}", momentumLongIdea: "восходящий моментум усиливается",
    momentumShortIdea: "нисходящий моментум усиливается",
    fundSummary: "Сводка KPI FundRep", valuation: "Оценка", growth: "Рост", profitability: "Прибыльность",
    debt: "Долг", momentum: "Моментум", keyRisks: "Ключевые риски", reportDate: "Дата",
    disclaimer: "Не является инвестиционной рекомендацией.", metric: "Метрика", value: "Значение", explanation: "Объяснение",
    fundTitle: "Фундаментальный отчёт по {ticker}", dataFull: "Фундаментальные данные Yahoo Finance получены.",
    dataPartial: "Доступны только частичные данные Yahoo Finance.", dataUnavailable: "Фундаментальные данные недоступны.",
    quickGuide: "Прибыльность показывает качество прибыли; оценка — цену; денежный поток — реальные деньги; финансовое здоровье — прочность баланса; будущие сигналы — изменение ожиданий рынка.",
    promptIntro: "Используйте этот запрос в Perplexity Finance:", promptRequest: "Подготовьте профессиональный PDF-отчёт по тикеру {ticker}.",
    promptStructure: "Структура отчёта", promptInputs: "Текущие технические данные", promptFinal: "Для каждого KPI объясните значение, причину изменения, влияние на инвестора и показатели для дальнейшего наблюдения. Оформите результат как современную аналитическую панель с графиками, KPI и кратким инвестиционным выводом.",
    prompt1: "Отчёт о прибылях и убытках: выручка, маржа, прибыль, динамика и причины изменений.", prompt2: "Моментум: тренд цены, относительная сила, RSI, объём и ключевые уровни.",
    prompt3: "История оценки: мультипликаторы в сравнении с историей компании и сектором. Добавьте CAPE, метод расчёта, ограничения для отдельной компании и вывод по нормализованной прибыли.",
    prompt4: "Капитал и уверенность инвесторов: баланс, долги, обратный выкуп, активность инсайдеров и институциональных инвесторов.",
    reportFailed: "не удалось получить данные",
    status_signal_found: "сигнал найден", status_no_signal: "нет сигнала", status_not_enough_data: "недостаточно данных",
    status_invalid_ticker: "неверный тикер", status_data_provider_error: "ошибка поставщика данных", status_partial_result: "частичный результат",
    revenue: "Выручка", earnings: "Прибыль", gross: "Валовая маржа", operating: "Операционная маржа", net: "Чистая маржа",
    cash: "Денежные средства", change: "Изменение", marketCap: "Капитализация", currentRatio: "Текущая ликвидность",
    fundSection1: "1. Прибыльность", fundQuestion1: "Компания действительно зарабатывает и становится эффективнее?",
    fundSection2: "2. Оценка", fundQuestion2: "Хорошая ли это компания по разумной цене?",
    fundSection3: "3. Денежный поток", fundQuestion3: "Превращается ли бухгалтерская прибыль в реальный свободный денежный поток?",
    fundSection4: "4. Финансовое здоровье", fundQuestion4: "Сможет ли компания выдержать спад и финансировать рост?",
    fundSection5: "5. Будущие сигналы", fundQuestion5: "Как меняются ожидания относительно компании?",
    metricExplanationGeneric: "Сравните показатель с историей компании, конкурентами и последней отчётностью.",
    riskDebt: "Высокая долговая нагрузка относительно капитала.", riskLiquidity: "Текущая ликвидность ниже 1.",
    riskValuation: "Оценка по P/E выглядит требовательной.", riskRevenue: "Выручка снижается.",
    riskOverbought: "Акция может быть технически перегрета по RSI.", riskWeak: "Акция находится в зоне технической слабости по RSI.",
    riskDefault: "Ключевые риски требуют проверки по последней отчётности и новостям.",
    marketNews: "Новости рынка", country: "Страна", source: "Источник", published: "Опубликовано", tickers: "Тикеры",
  },
  he: {
    analysisTitle: "דוח ניתוח", status: "סטטוס", price: "מחיר", movement: "שינוי",
    distanceFromMma: "מרחק מ-MMA150", signals: "איתותים", why: "למה", condition: "תנאי",
    idea: "רעיון", stop: "סטופ", target: "יעד", risk: "סיכון", noSignal: "אין איתות",
    noSignalDetails: "תנאי הכניסה לא אושרו.", noData: "אין מספיק נתונים לניתוח", error: "שגיאה",
    signalFor: "איתות עבור {ticker}", strategy: "אסטרטגיה", unavailable: "לא זמין",
    side_long: "קנייה", side_short: "מכירה", strategy_Trend_Following: "מעקב מגמה",
    strategy_Breakout_Trading: "מסחר בפריצה", strategy_Volume_Profile_AVWAP: "פרופיל מחזור ו-AVWAP", strategy_Momentum_Trading: "מסחר במומנטום",
    trendAbove: "המחיר מעל EMA200", trendBelow: "המחיר מתחת ל-EMA200", trendNear: "המחיר סמוך ל-EMA200",
    mmaDistance: "מרחק מ-MMA150: {distance}", momentumPositive: "מומנטום חיובי",
    momentumNegative: "מומנטום שלילי", momentumNeutral: "מומנטום ניטרלי",
    trendLongCondition: "המחיר מעל EMA200 ומעל AVWAP", trendShortCondition: "המחיר מתחת ל-EMA200 ומתחת ל-AVWAP",
    trendLongIdea: "אפשרות לפוזיציית לונג", trendShortIdea: "אפשרות לפוזיציית שורט",
    breakoutLongCondition: "פריצה מעל השיא של 20 נרות", breakoutShortCondition: "שבירה מתחת לשפל של 20 נרות",
    breakoutLongIdea: "לונג מבוסס מומנטום", breakoutShortIdea: "שורט מבוסס מומנטום",
    volumeLongCondition: "המחיר מעל AVWAP ומעל POC", volumeShortCondition: "המחיר מתחת ל-AVWAP ומתחת ל-POC",
    volumeLongIdea: "הקונים שומרים על שליטה", volumeShortIdea: "המוכרים שומרים על שליטה",
    momentumCondition: "ROC20 {roc}% ו-RSI14 {rsi}", momentumLongIdea: "המומנטום כלפי מעלה מתחזק",
    momentumShortIdea: "המומנטום כלפי מטה מתחזק",
    fundSummary: "סיכום מדדי FundRep", valuation: "תמחור", growth: "צמיחה", profitability: "רווחיות",
    debt: "חוב", momentum: "מומנטום", keyRisks: "סיכונים מרכזיים", reportDate: "תאריך",
    disclaimer: "אין לראות בדוח המלצה להשקעה.", metric: "מדד", value: "ערך", explanation: "הסבר",
    fundTitle: "דוח פונדמנטלי עבור {ticker}", dataFull: "התקבלו נתונים פונדמנטליים מ-Yahoo Finance.",
    dataPartial: "זמינים רק נתונים חלקיים מ-Yahoo Finance.", dataUnavailable: "נתונים פונדמנטליים אינם זמינים.",
    quickGuide: "רווחיות מציגה את איכות הרווח; תמחור מציג את המחיר; תזרים מזומנים מציג יצירת מזומן; בריאות פיננסית מציגה את חוזק המאזן; איתותים עתידיים מציגים שינוי בציפיות השוק.",
    promptIntro: "השתמשו בהנחיה זו ב-Perplexity Finance:", promptRequest: "הכינו דוח PDF מקצועי עבור הסימול {ticker}.",
    promptStructure: "מבנה הדוח", promptInputs: "נתונים טכניים נוכחיים", promptFinal: "לכל מדד הסבירו מה משמעותו, מדוע השתנה, כיצד הוא משפיע על המשקיע ומה יש לעקוב אחריו. הציגו את התוצאה כלוח ניתוח מודרני עם גרפים, מדדים ומסקנת השקעה קצרה.",
    prompt1: "דוח רווח והפסד: הכנסות, מרווחים, רווח, מגמות והסיבות לשינויים.", prompt2: "מומנטום: מגמת מחיר, חוזק יחסי, RSI, מחזור ורמות מפתח.",
    prompt3: "היסטוריית תמחור: מכפילים בהשוואה להיסטוריית החברה ולענף. הוסיפו CAPE, שיטת חישוב, מגבלות ברמת חברה ומסקנה המבוססת על רווח מנורמל.",
    prompt4: "הון ואמון: מאזן, חוב, רכישה עצמית ופעילות בעלי עניין ומשקיעים מוסדיים.",
    reportFailed: "לא ניתן היה לקבל נתונים",
    status_signal_found: "נמצא איתות", status_no_signal: "אין איתות", status_not_enough_data: "אין מספיק נתונים",
    status_invalid_ticker: "סימול לא תקין", status_data_provider_error: "שגיאת ספק נתונים", status_partial_result: "תוצאה חלקית",
    revenue: "הכנסות", earnings: "רווחים", gross: "רווחיות גולמית", operating: "רווחיות תפעולית", net: "רווחיות נקייה",
    cash: "מזומנים", change: "שינוי", marketCap: "שווי שוק", currentRatio: "יחס שוטף",
    fundSection1: "1. רווחיות", fundQuestion1: "האם החברה מייצרת רווח אמיתי ומשפרת יעילות?",
    fundSection2: "2. תמחור", fundQuestion2: "האם זו חברה טובה במחיר סביר?",
    fundSection3: "3. תזרים מזומנים", fundQuestion3: "האם הרווח החשבונאי הופך לתזרים מזומנים חופשי?",
    fundSection4: "4. בריאות פיננסית", fundQuestion4: "האם החברה יכולה לעמוד בהאטה ולממן צמיחה?",
    fundSection5: "5. איתותים עתידיים", fundQuestion5: "כיצד משתנות הציפיות לגבי החברה?",
    metricExplanationGeneric: "יש להשוות את המדד להיסטוריית החברה, למתחרים ולדוחות העדכניים.",
    riskDebt: "רמת החוב גבוהה ביחס להון.", riskLiquidity: "יחס הנזילות השוטפת נמוך מ-1.",
    riskValuation: "תמחור ה-P/E נראה גבוה.", riskRevenue: "ההכנסות בירידה.",
    riskOverbought: "ייתכן שהמניה נמצאת בקניית יתר לפי RSI.", riskWeak: "המניה נמצאת בחולשה טכנית לפי RSI.",
    riskDefault: "יש לאמת את הסיכונים המרכזיים מול הדוחות והחדשות העדכניים.",
    marketNews: "חדשות שוק", country: "מדינה", source: "מקור", published: "פורסם", tickers: "סימולים",
  },
};

const FUND_METRIC_LABELS = {
  ru: {
    "Company": "Компания", "Current price": "Текущая цена", "Revenue Growth": "Рост выручки",
    "Gross Margin": "Валовая маржа", "Operating Margin": "Операционная маржа", "Net Margin": "Чистая маржа",
    "EPS": "Прибыль на акцию", "Market Cap": "Капитализация", "P/E": "Цена к прибыли",
    "Forward P/E": "Будущий P/E", "CAPE": "Циклически скорректированный P/E", "P/S": "Цена к выручке",
    "P/B": "Цена к балансовой стоимости", "Operating Cash Flow": "Операционный денежный поток",
    "Free Cash Flow": "Свободный денежный поток", "Debt-to-Equity": "Долг к капиталу",
    "Total Cash": "Денежные средства", "Total Debt": "Общий долг", "Current Ratio": "Текущая ликвидность",
    "ROE": "Рентабельность капитала", "ROA": "Рентабельность активов", "Recommendation": "Рекомендация аналитиков",
    "Target Mean Price": "Средняя целевая цена", "Earnings Growth": "Рост прибыли",
    "Dividend Yield": "Дивидендная доходность", "Technical context": "Технический контекст",
  },
  he: {
    "Company": "חברה", "Current price": "מחיר נוכחי", "Revenue Growth": "צמיחת הכנסות",
    "Gross Margin": "רווחיות גולמית", "Operating Margin": "רווחיות תפעולית", "Net Margin": "רווחיות נקייה",
    "EPS": "רווח למניה", "Market Cap": "שווי שוק", "P/E": "מכפיל רווח", "Forward P/E": "מכפיל רווח עתידי",
    "CAPE": "מכפיל רווח מותאם מחזורית", "P/S": "מכפיל מכירות", "EV": "שווי פעילות",
    "PEG Ratio": "יחס PEG", "P/B": "מכפיל הון", "Operating Cash Flow": "תזרים מזומנים תפעולי",
    "Free Cash Flow": "תזרים מזומנים חופשי", "FCF Margin": "שיעור תזרים חופשי", "FCF Yield": "תשואת תזרים חופשי",
    "Debt-to-Equity": "יחס חוב להון", "Total Cash": "סך מזומנים", "Total Debt": "סך חוב",
    "Current Ratio": "יחס שוטף", "ROE": "תשואה על ההון", "ROA": "תשואה על הנכסים",
    "Recommendation": "המלצת אנליסטים", "Target Mean Price": "מחיר יעד ממוצע", "Earnings Growth": "צמיחת רווחים",
    "Beta": "בטא", "Dividend Yield": "תשואת דיבידנד", "Technical context": "הקשר טכני",
  },
};

export function normalizeReportLanguage(value) {
  const language = String(value || "ru").trim().toLowerCase().replace("_", "-");
  if (language === "iw" || language.startsWith("iw-") || language.startsWith("he-")) return "he";
  if (language.startsWith("en-")) return "en";
  if (language.startsWith("ru-")) return "ru";
  return TEXT[language] ? language : "ru";
}

export function isSupportedReportLanguage(value) {
  if (value == null || String(value).trim() === "") return true;
  const language = String(value).trim().toLowerCase().replace("_", "-");
  return language === "ru" || language.startsWith("ru-")
    || language === "en" || language.startsWith("en-")
    || language === "he" || language.startsWith("he-")
    || language === "iw" || language.startsWith("iw-");
}

export function reportText(language, key, values = {}) {
  const locale = normalizeReportLanguage(language);
  const template = TEXT[locale][key] ?? TEXT.en[key] ?? key;
  return String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
}

export function fundMetricLabel(language, label) {
  const locale = normalizeReportLanguage(language);
  const english = String(label).split(" / ")[0];
  return FUND_METRIC_LABELS[locale]?.[english] || english;
}
