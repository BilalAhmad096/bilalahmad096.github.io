const hadiths = [
  {
    ar: "إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ",
    en: "Actions are judged by intentions.",
    ref: "Sahih Bukhari 1"
  },
  {
    ar: "لَا يُؤْمِنُ أَحَدُكُمْ حَتَّىٰ يُحِبَّ لِأَخِيهِ مَا يُحِبُّ لِنَفْسِهِ",
    en: "None of you truly believes until he loves for his brother what he loves for himself.",
    ref: "Sahih Bukhari 13"
  },
  {
    ar: "الرَّاحِمُونَ يَرْحَمُهُمُ الرَّحْمٰنُ",
    en: "The Merciful shows mercy to those who show mercy.",
    ref: "Sunan al-Tirmidhi 1924"
  },
  {
    ar: "الكَلِمَةُ الطَّيِّبَةُ صَدَقَةٌ",
    en: "A good word is charity.",
    ref: "Sahih Bukhari 2989"
  },
  {
    ar: "خَيْرُ النَّاسِ أَنْفَعُهُمْ لِلنَّاسِ",
    en: "The best of people are those who are most beneficial to others.",
    ref: "Sahih al-Jami’ 3289"
  },
  {
    ar: "إِنَّ اللهَ جَمِيلٌ يُحِبُّ الْجَمَالَ",
    en: "Allah is beautiful and He loves beauty.",
    ref: "Sahih Muslim 91"
  },
  {
    ar: "لَا تَغْضَبْ",
    en: "Do not become angry.",
    ref: "Sahih Bukhari 6116"
  }
];

function getHadithOfTheDay() {
  const today = new Date();
  const dayOfYear = Math.floor(
    (today - new Date(today.getFullYear(), 0, 0)) / 86400000
  );
  const index = dayOfYear % hadiths.length;
  return hadiths[index];
}

window.addEventListener("DOMContentLoaded", () => {
  const h = getHadithOfTheDay();

  const arEl = document.getElementById("hadith-ar");
  const enEl = document.getElementById("hadith-en");
  const refEl = document.getElementById("hadith-ref");

  if (arEl && enEl && refEl) {
    arEl.textContent = h.ar;
    enEl.textContent = "“" + h.en + "”";
    refEl.textContent = "— " + h.ref;
  }
});
