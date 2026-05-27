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

    return res.status(200).json(data);

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Strategic overview generation failed."
    });
  }
}