export default async function handler(req, res) {
  try {
    const response = await fetch("https://hook.us2.make.com/278a8h6hk8mfurlmgin8k50to0mwe4h5", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    document.getElementById("overviewText").innerText = data.overview || "";
    document.getElementById("positioningPriority").innerText = data.positioning_priority || "";
    document.getElementById("expansionPriority").innerText = data.expansion_priority || "";
    document.getElementById("visibilityPriority").innerText = data.visibility_priority || "";
    document.getElementById("marketPotential").innerText = data.market_potential || "";
    document.getElementById("revenuePotential").innerText = data.revenue_potential || "";
    document.getElementById("blueprintText").innerText = data.blueprint || "";
    
    document.getElementById("loadingScreen").style.display = "none";
    document.getElementById("strategicOverview").style.display = "block";

    return res.status(200).json(data);

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Strategic overview generation failed."
    });
  }
}