// Excel charts for an XLSX workbook made with SheetJS. SheetJS (community edition) writes no charts, so the workbook is
// written, opened as the zip it is (SheetJS's own CFB), and each chart added as Excel stores it: a chart part
// (DrawingML), a drawing that places it over the cells, and the relationships and content types that tie them in.
// The charts read their numbers from the workbook's cells, so they stay live in Excel.
//
// XlsxCharts.write(wb, charts, filename) / XlsxCharts.build(wb, charts) -> Uint8Array
//   charts: [{ sheet, type: "bar" (horizontal) | "col" | "pie" | "line", title, at: { col, row, cols, rows },
//              series: [{ name, cats: "'Sheet'!$A$2:$A$9", vals: "'Sheet'!$B$2:$B$9", color: "E34948" }],
//              colors: ["EB6834", …] (pie slices), numFmt: "#,##0" }]
(function (root) {
  "use strict";
  const NS = {
    c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
    a: "http://schemas.openxmlformats.org/drawingml/2006/main",
    r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    xdr: "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  };
  const T = { chart: `${NS.r}/chart`, drawing: `${NS.r}/drawing` };
  const CT = { chart: "application/vnd.openxmlformats-officedocument.drawingml.chart+xml", drawing: "application/vnd.openxmlformats-officedocument.drawing+xml" };
  const xe = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
  // a range on a sheet, as a chart formula: 'By shift'!$A$2:$A$4
  const ref = (sheet, c0, r0, c1, r1) => {
    const col = (n) => { let s = ""; for (n++; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
    return `'${String(sheet).replace(/'/g, "''")}'!$${col(c0)}$${r0 + 1}:$${col(c1)}$${r1 + 1}`;
  };
  const fill = (hex) => `<c:spPr><a:solidFill><a:srgbClr val="${xe(hex)}"/></a:solidFill></c:spPr>`;
  const text = (s, sz = 1200, b = 1) => `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="${b}"/></a:pPr><a:r><a:rPr lang="en-GB" sz="${sz}" b="${b}"/><a:t>${xe(s)}</a:t></a:r></a:p></c:rich></c:tx>`;
  const grid = `<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E1E0D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>`;
  const axText = `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:endParaRPr lang="en-GB"/></a:p></c:txPr>`;
  const axLine = `<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="C3C2B7"/></a:solidFill></a:ln></c:spPr>`;

  function chartXml(ch) {
    const sers = ch.series || [];
    const title = ch.title ? `<c:title>${text(ch.title)}<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : `<c:autoTitleDeleted val="1"/>`;
    const legend = ch.type === "pie" || sers.length > 1 ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>` : "";
    let plot;
    if (ch.type === "pie") {
      const s = sers[0];
      const pts = (ch.colors || []).map((col, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${xe(col)}"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join("");
      plot = `<c:pieChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${xe(s.name)}</c:v></c:tx>${pts}`
        + `<c:dLbls><c:numFmt formatCode="0%" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="1"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:separator>: </c:separator><c:showLeaderLines val="1"/></c:dLbls>`
        + `<c:cat><c:strRef><c:f>${xe(s.cats)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${xe(s.vals)}</c:f></c:numRef></c:val></c:ser><c:firstSliceAng val="0"/></c:pieChart>`;
    } else {
      const horiz = ch.type === "bar", line = ch.type === "line", fmt = xe(ch.numFmt || "#,##0");
      const ser = sers.map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${xe(s.name)}</c:v></c:tx>`
        + (line ? `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${xe(s.color || "2A78D6")}"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>`
          : `${fill(s.color || "2A78D6")}<c:invertIfNegative val="0"/>`)
        + `<c:cat><c:strRef><c:f>${xe(s.cats)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${xe(s.vals)}</c:f></c:numRef></c:val>${line ? `<c:smooth val="0"/>` : ""}</c:ser>`).join("");
      // horizontal bars read top-down in the sheet's order, the value axis along the bottom
      const cat = `<c:catAx><c:axId val="111"/><c:scaling><c:orientation val="${horiz ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${horiz ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>${axLine}${axText}<c:crossAx val="222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
      const val = `<c:valAx><c:axId val="222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horiz ? "b" : "l"}"/>${grid}<c:numFmt formatCode="${fmt}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${axText}<c:crossAx val="111"/><c:crosses val="${horiz ? "max" : "autoZero"}"/><c:crossBetween val="between"/></c:valAx>`;
      plot = line
        ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}<c:marker val="1"/><c:axId val="111"/><c:axId val="222"/></c:lineChart>${cat}${val}`
        : `<c:barChart><c:barDir val="${horiz ? "bar" : "col"}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${ser}<c:gapWidth val="60"/><c:overlap val="100"/><c:axId val="111"/><c:axId val="222"/></c:barChart>${cat}${val}`;
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><c:roundedCorners val="0"/>`
      + `<c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>`
      + `<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:chartSpace>`;
  }
  const anchor = (ch, i, rid) => {
    const { col = 0, row = 0, cols = 8, rows = 16 } = ch.at || {};
    const pt = (c, r) => `<xdr:col>${c}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${r}</xdr:row><xdr:rowOff>0</xdr:rowOff>`;
    return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from>${pt(col, row)}</xdr:from><xdr:to>${pt(col + cols, row + rows)}</xdr:to>`
      + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="${xe(ch.title || "Chart " + (i + 1))}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
      + `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS.c}"><c:chart xmlns:c="${NS.c}" xmlns:r="${NS.r}" r:id="${rid}"/></a:graphicData></a:graphic>`
      + `</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  };
  const rels = (list) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS.rel}">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${xe(target)}"/>`).join("")}</Relationships>`;

  function build(wb, charts) {
    const XLSX = root.XLSX, CFB = XLSX.CFB;
    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    if (!charts || !charts.length) return new Uint8Array(out);
    const zip = CFB.read(new Uint8Array(out), { type: "array" });
    const enc = new TextEncoder(), dec = new TextDecoder();
    const get = (p) => { const e = CFB.find(zip, p); return e ? dec.decode(e.content) : null; };
    const put = (p, s) => { const e = CFB.find(zip, p); if (e) { e.content = enc.encode(s); e.size = e.content.length; } else CFB.utils.cfb_add(zip, p, enc.encode(s)); };
    let ct = get("/[Content_Types].xml");
    const bySheet = new Map();
    for (const ch of charts) { if (!bySheet.has(ch.sheet)) bySheet.set(ch.sheet, []); bySheet.get(ch.sheet).push(ch); }
    let n = 0, d = 0;
    for (const [sheet, list] of bySheet) {
      const si = wb.SheetNames.indexOf(sheet);
      if (si < 0) throw new Error(`No sheet "${sheet}" for a chart`);
      d++;
      const drawRels = [], anchors = [];
      list.forEach((ch, i) => {
        n++;
        put(`/xl/charts/chart${n}.xml`, chartXml(ch));
        ct = ct.replace("</Types>", `<Override PartName="/xl/charts/chart${n}.xml" ContentType="${CT.chart}"/></Types>`);
        drawRels.push([`rId${i + 1}`, T.chart, `../charts/chart${n}.xml`]);
        anchors.push(anchor(ch, i, `rId${i + 1}`));
      });
      put(`/xl/drawings/drawing${d}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS.xdr}" xmlns:a="${NS.a}">${anchors.join("")}</xdr:wsDr>`);
      put(`/xl/drawings/_rels/drawing${d}.xml.rels`, rels(drawRels));
      ct = ct.replace("</Types>", `<Override PartName="/xl/drawings/drawing${d}.xml" ContentType="${CT.drawing}"/></Types>`);
      // the sheet points at its drawing (added to any relationships it already has)
      const sp = `/xl/worksheets/sheet${si + 1}.xml`, rp = `/xl/worksheets/_rels/sheet${si + 1}.xml.rels`;
      const id = "rIdDrawing1", old = get(rp);
      put(rp, old ? old.replace("</Relationships>", `<Relationship Id="${id}" Type="${T.drawing}" Target="../drawings/drawing${d}.xml"/></Relationships>`) : rels([[id, T.drawing, `../drawings/drawing${d}.xml`]]));
      let sx = get(sp);
      if (!/xmlns:r=/.test(sx)) sx = sx.replace("<worksheet ", `<worksheet xmlns:r="${NS.r}" `);
      put(sp, sx.replace("</worksheet>", `<drawing r:id="${id}"/></worksheet>`));
    }
    put("/[Content_Types].xml", ct);
    return new Uint8Array(CFB.write(zip, { fileType: "zip", type: "array" }));
  }
  function write(wb, charts, filename) {
    const bytes = build(wb, charts);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  root.XlsxCharts = { build, write, ref };
  if (typeof module !== "undefined" && module.exports) module.exports = root.XlsxCharts;
})(typeof window !== "undefined" ? window : globalThis);
