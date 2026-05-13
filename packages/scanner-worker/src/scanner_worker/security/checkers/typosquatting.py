"""
Typosquatting Detection
Detects dependency confusion and typosquatting attacks in package configurations.
"""

import json
import re

import httpx

from scanner_worker.security.models import Finding, SeverityLevel
from scanner_worker.security.payloads import SecurityPayloads


def levenshtein_distance(s1: str, s2: str) -> int:
    """Compute the Levenshtein edit distance between two strings."""
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)

    prev_row = list(range(len(s2) + 1))
    for i, c1 in enumerate(s1):
        curr_row = [i + 1]
        for j, c2 in enumerate(s2):
            cost = 0 if c1 == c2 else 1
            curr_row.append(min(
                curr_row[j] + 1,        # insert
                prev_row[j + 1] + 1,    # delete
                prev_row[j] + cost,      # substitute
            ))
        prev_row = curr_row
    return prev_row[-1]


class TyposquattingChecker:
    """Detects potential typosquatting in agent dependency files."""

    def __init__(self, timeout: float = 30.0):
        self.timeout = timeout

    async def check_all(self, target_url: str) -> list[Finding]:
        """Run all typosquatting checks."""
        findings = []
        findings.extend(await self._check_dependency_files(target_url))
        return findings

    async def _check_dependency_files(self, target_url: str) -> list[Finding]:
        """Fetch dependency files and check package names for typosquatting."""
        findings = []

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for config_path in SecurityPayloads.PACKAGE_CONFIG_PATHS:
                try:
                    url = f"{target_url.rstrip('/')}{config_path}"
                    response = await client.get(url)
                    if response.status_code != 200:
                        continue

                    packages = self._extract_packages(response.text, config_path)
                    suspects = self._find_typosquats(packages)

                    for pkg, similar_to, distance in suspects:
                        findings.append(Finding(
                            id="TYPO-001",
                            severity=SeverityLevel.HIGH,
                            title=f"Possible Typosquatting: '{pkg}'",
                            description=(
                                f"Package '{pkg}' is suspiciously similar to the popular "
                                f"package '{similar_to}' (edit distance: {distance}). "
                                "This could be a typosquatting attack where a malicious "
                                "package impersonates a well-known one."
                            ),
                            affected_endpoint=url,
                            evidence=f"'{pkg}' is {distance} edit(s) from '{similar_to}'",
                            remediation=(
                                f"1. Verify that '{pkg}' is the intended package, not '{similar_to}'. "
                                "2. Check the package's npm/PyPI page for publisher info and download counts. "
                                "3. Use lockfiles to pin exact versions. "
                                "4. Consider using package provenance verification."
                            ),
                            cwe_id="CWE-829",
                            cvss_score=8.2,
                            references=[
                                "https://blog.phylum.io/typosquatting-via-npm-packages"
                            ],
                        ))

                except Exception:
                    continue

        return findings

    def _extract_packages(self, content: str, path: str) -> list[str]:
        """Extract package names from a dependency file."""
        packages = []

        if path.endswith("package.json"):
            try:
                data = json.loads(content)
                for dep_key in ("dependencies", "devDependencies", "peerDependencies"):
                    if dep_key in data and isinstance(data[dep_key], dict):
                        packages.extend(data[dep_key].keys())
            except (json.JSONDecodeError, KeyError):
                pass

        elif path.endswith("requirements.txt"):
            for line in content.splitlines():
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("-"):
                    continue
                # Strip version specifiers
                pkg = re.split(r"[>=<!\[;]", line)[0].strip()
                if pkg:
                    packages.append(pkg)

        elif path.endswith("pyproject.toml"):
            # Simple extraction from [project.dependencies]
            in_deps = False
            for line in content.splitlines():
                if "dependencies" in line and "=" in line:
                    in_deps = True
                    continue
                if in_deps:
                    if line.strip().startswith("]"):
                        in_deps = False
                        continue
                    match = re.match(r'\s*"([^">=<!\[]+)', line)
                    if match:
                        packages.append(match.group(1).strip())

        return packages

    def _find_typosquats(self, packages: list[str]) -> list[tuple[str, str, int]]:
        """Find packages that are suspiciously close to known-good packages."""
        suspects = []

        known_npm = SecurityPayloads.KNOWN_GOOD_NPM_PACKAGES
        known_pypi = SecurityPayloads.KNOWN_GOOD_PYPI_PACKAGES
        all_known = known_npm + known_pypi

        for pkg in packages:
            pkg_lower = pkg.lower()
            # Skip if it's an exact match with a known package
            if pkg_lower in {k.lower() for k in all_known}:
                continue

            for known in all_known:
                known_lower = known.lower()
                # Only check packages of similar length
                if abs(len(pkg_lower) - len(known_lower)) > 2:
                    continue
                dist = levenshtein_distance(pkg_lower, known_lower)
                if 1 <= dist <= 2:
                    suspects.append((pkg, known, dist))
                    break  # One match per suspect is enough

        return suspects
