// Per-team detail view — groundwork for the future live-race-day mode (real
// punch times fed in per team). Deliberately NOT in the visible nav-dropdown
// yet; reachable only via #/joukkue until live mode is actually built.
// Read-only: DNS/DNF is edited from Sarjat, not duplicated here.
import { getState } from "../state.js";
import { escapeText } from "../util/format.js";
import { bindCollapse } from "../util/collapseMemory.js";

export function render(root) {
  const state = getState();
  const card = document.createElement("details");
  card.className = "card";
  bindCollapse(card, "joukkueet-main");
  card.innerHTML = `
    <summary><h2>Joukkueet</h2></summary>
    <p class="text-muted" style="margin-top:0">
      Live-tila ja oikeat leimausajat tulevat myöhemmin. Tämä näkymä listaa
      joukkueet valmiiksi sitä varten — ei vielä linkitetty päävalikkoon.
    </p>
    <table class="cp-table">
      <thead>
        <tr>
          <th>Joukkue</th>
          <th>Sarja</th>
          <th class="nowrap">Tila</th>
        </tr>
      </thead>
      <tbody>
        ${state.categories.flatMap(teamRowsHtml).join("")}
      </tbody>
    </table>
  `;
  root.appendChild(card);
}

function teamRowsHtml(cat) {
  const withdrawn = new Set(cat.withdrawnTeamIndices || []);
  return Array.from({ length: cat.teamCount }, (_, i) => i + 1).map(n => `
    <tr class="${withdrawn.has(n) ? "team-row withdrawn" : ""}">
      <td>${escapeText(cat.name)} ${n}</td>
      <td><span class="series-dot" style="background:${cat.color}"></span>${escapeText(cat.name)}</td>
      <td class="nowrap">${withdrawn.has(n) ? '<span class="dns-badge">DNS/DNF</span>' : '<span class="badge ok">Starttaa</span>'}</td>
    </tr>
  `);
}
