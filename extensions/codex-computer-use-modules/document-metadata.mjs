// CUA abbreviates the Window header; the standard-window row retains its AX title.
export function documentTitle(elements, headerTitle) {
	const windows = elements.filter(element => element.role === "standard window");
	if (windows.length !== 1) return headerTitle;
	// Generic element names strip parenthesized attributes; window titles are literal.
	const row = windows[0].line.split("\n")[0].replace(/^\d+\s+standard window\s*/i, "");
	const label = row.split(/(?:^|,\s*)(?:ID|Description|Help|Secondary Actions|URL|Value|Placeholder):/i)[0];
	const title = label || row.match(/(?:^|, )Secondary Actions: Raise, (.+)$/)?.[1];
	return title || headerTitle;
}

// Document metadata, never arbitrary URLs in body text or link labels.
export function documentUrl(elements) {
	const windowUrl = elements.find(element => element.role === "standard window")?.url;
	const pageUrls = [...new Set(elements.filter(element => ["web area", "html content"].includes(element.role)).map(element => element.url).filter(Boolean))];
	const url = windowUrl || (pageUrls.length === 1 ? pageUrls[0] : null);
	if (!url) return null;
	const hostPort = /^[^/?#:\s]+:\d+(?:[/?#]|$)/.test(url);
	if (/^[a-z][\w+.-]*:/i.test(url) && !hostPort) return url;
	// Chromium's window URL omits the scheme; its address field retains it.
	// Use that value only when it describes the same displayed document URL.
	const display = value => value.replace(/^[a-z][\w+.-]*:\/\//i, "").replace(/\/$/, "");
	const addresses = [...new Set(elements.filter(element => /field|search/.test(element.role)
		&& /address|location|omnibox/i.test(element.name ?? element.description ?? ""))
		.map(element => element.value?.trim()).filter(value => value && /^[a-z][\w+.-]*:\/\//i.test(value) && display(value) === display(url)))];
	return addresses.length === 1 ? addresses[0] : url;
}
