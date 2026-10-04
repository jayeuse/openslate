"""The application network cannot reach Supabase administrative services."""

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[4]
SUPABASE = ROOT / "infra/supabase"


class ComposeLoader(yaml.SafeLoader):
    pass


ComposeLoader.add_constructor("!reset", lambda loader, node: loader.construct_sequence(node))


def test_application_network_cannot_reach_meta_or_studio() -> None:
    base = yaml.safe_load((SUPABASE / "compose.yaml").read_text(encoding="utf-8"))
    production = yaml.load(
        (SUPABASE / "compose.production.yaml").read_text(encoding="utf-8"),
        Loader=ComposeLoader,
    )
    services = base["services"]
    networks = {name: set(service.get("networks", [])) for name, service in services.items()}
    for name in ("api", "scanner-worker"):
        networks[name] = set(production["services"][name]["networks"])

    for app in ("api", "scanner-worker"):
        assert networks[app].isdisjoint(networks["meta"])
        assert networks[app].isdisjoint(networks["studio"])
    assert networks["meta"] == {"operator"}
    assert "operator" in networks["db"] & networks["studio"]
    assert "studio-ingress" in networks["studio"] & networks["api-gw"]
    assert "provider" in networks["db"] & networks["api"]
    assert "provider" in networks["api-gw"] & networks["auth"] & networks["storage"]
    assert base["networks"]["operator"]["internal"] is True
    assert base["networks"]["studio-ingress"]["internal"] is True


def test_gateway_explicitly_denies_metadata_paths_before_studio_fallback() -> None:
    listener = yaml.safe_load(
        (SUPABASE / "upstream/envoy/lds.template.yaml").read_text(encoding="utf-8")
    )
    routes = listener["resources"][0]["filter_chains"][0]["filters"][0]["typed_config"][
        "route_config"
    ]["virtual_hosts"][0]["routes"]
    fallback = next(
        index for index, route in enumerate(routes) if route["match"] == {"prefix": "/"}
    )
    for match in ({"path": "/pg"}, {"prefix": "/pg/"}):
        route_index = next(index for index, route in enumerate(routes) if route["match"] == match)
        assert route_index < fallback
        assert routes[route_index]["direct_response"]["status"] == 404
    assert all(route.get("route", {}).get("cluster") != "meta" for route in routes)
    clusters = yaml.safe_load(
        (SUPABASE / "upstream/envoy/cds.yaml").read_text(encoding="utf-8")
    )["resources"]
    assert all(cluster["name"] != "meta" for cluster in clusters)
